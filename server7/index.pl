#!/usr/bin/perl

use IO::Socket;
use POSIX ":sys_wait_h";

$port = 8080;
$memory_mb = 32;
$workers = 12;
$backlog = 64;
$window = 10;
$normal_recent = 40;
$normal_drop = 50;
$vip_recent = 200;
$vip_drop = 260;
$max_line = 4096;
$read_timeout = 1;

# 最後のサーバー。メモリ、制限、分類、複数processを全部入れる。
# 毎回forkすると負荷時に弱いので、workerを先に作って待たせる。
# queueはアプリ側で持たず、kernelのlisten backlogに寄せる。
# nofile=128以上を前提に、backlogは他のサーバーより大きくする。
$big_memory = "x" x ($memory_mb * 1024 * 1024);

$server = IO::Socket::INET->new(
    LocalPort => $port,
    Proto     => "tcp",
    Listen    => $backlog,
    Reuse     => 1,
) || die "cannot listen: $!";

$SIG{TERM} = sub {
    foreach $pid (keys %child) {
        kill "TERM", $pid;
    }
    exit;
};

$SIG{INT} = sub {
    foreach $pid (keys %child) {
        kill "INT", $pid;
    }
    exit;
};

print "Server7 start port=$port workers=$workers backlog=$backlog\n";

while (1) {
#   workerが足りなければ起動する。落ちたworkerもここで戻す。
    while (keys(%child) < $workers) {
        spawn_worker(keys(%child) + 1);
    }

#   親は子を見張るだけ。
    $pid = wait();
    delete $child{$pid} if ($pid > 0);
}

sub spawn_worker {
    ($worker_no) = @_;

    $pid = fork();
    die "cannot fork: $!" unless defined $pid;

    if ($pid == 0) {
#       子プロセスはacceptして処理し続ける。
        while ($client = $server->accept()) {
            handle_client($client, $worker_no);
        }
        exit;
    }

    $child{$pid} = 1;
}

sub handle_client {
    ($client, $worker_no) = @_;

#   先に短い制限付きで読む。巨大行とslow headerはここで落とす。
    $request = read_request($client);
    if ($request eq "") {
        close($client);
        return;
    }

    ($method, $uri, $proto) = split(/ /, $request);
    ($path, $query) = split(/\?/, $uri);

    $query = "" unless defined $query;
    $name = $query;
    $name = $2 if ($query =~ /(^|&)name=([^&]*)/);

#   nameで雑に分類する。normal/vipは守り、attackっぽいものは早めに落とす。
    $class = classify_request($path, $name);
    $limit = check_limit($client->peerhost, $class);

    if ($limit eq "drop") {
#       何度も来る相手には返事もしない。
        close($client);
        return;
    }

    if ($limit eq "busy") {
#       少し超えた分だけ503にする。
        old_busy($client, "Server7", "rate limit");
        return;
    }

    old_reply($client, "Server7", "$name</p><p>class=$class</p><p>worker=$worker_no pid=$$");
}

sub read_request {
    ($client) = @_;

#   workerが遅い相手や巨大requestに掴まれっぱなしにならないようにする。
    $line = "";
    eval {
        local $SIG{ALRM} = sub { die "timeout\n"; };
        alarm($read_timeout);

        while (1) {
            $n = sysread($client, $part, 1024);
            last if (!defined $n || $n <= 0);
            $line .= $part;
            last if ($line =~ /\n/);
            die "too long\n" if (length($line) > $max_line);
        }

        alarm(0);
    };

    alarm(0);

#   timeoutや巨大行は返事をせず切る。
    return "" if ($@);
    return "" if (length($line) > $max_line);
    return $line;
}

sub classify_request {
    ($path, $name) = @_;

#   古いサーバーらしく、nameの先頭だけで雑に分ける。
    return "vip" if ($name =~ /^vip/ || $name =~ /^admin/);
    return "slow" if ($name =~ /^slow/ || $path =~ /^\/slow/);
    return "attack" if ($name =~ /^attack/);
    return "normal";
}

sub check_limit {
    ($ip, $class) = @_;

#   preforkなので、この表はworkerごとに別々に持つ。
#   12workerで分散する前提なので、1workerあたりの値にしておく。
    $now = time;
    $key = "$class:$ip";
    @old = split(/,/, $access{$key});
    @new = ();
    foreach $t (@old) {
        push(@new, $t) if ($t > $now - $window);
    }

    push(@new, $now);
    $access{$key} = join(",", @new);

    if ($class eq "vip") {
        return "drop" if (@new > $vip_drop);
        return "busy" if (@new > $vip_recent);
        return "ok";
    }

    return "drop" if (@new > $normal_drop);
    return "busy" if (@new > $normal_recent);
    return "ok";
}

sub old_reply {
    ($client, $server_name, $text) = @_;

#   古いHTML返却。
    print $client "HTTP/1.0 200 OK\r\n";
    print $client "Content-Type: text/html\r\n";
    print $client "\r\n";
    print $client "<html><body>";
    print $client "<h1>$server_name</h1>";
    print $client "<p>$text</p>";
    print $client "</body></html>";
    close($client);
}

sub old_busy {
    ($client, $server_name, $text) = @_;

#   忙しいときは雑に503。
    print $client "HTTP/1.0 503 Service Unavailable\r\n";
    print $client "Content-Type: text/html\r\n";
    print $client "\r\n";
    print $client "<html><body><h1>$server_name</h1><p>$text</p></body></html>";
    close($client);
}
