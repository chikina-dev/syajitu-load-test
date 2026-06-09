#!/usr/bin/perl

use IO::Socket;

$port = 8080;
$workers = 8;
$backlog = 8;
$max_line = 8192;
$read_timeout = 3;

# pids=16から逆算して、親1個とworker 8個にする。
# nofile=32なので、kernel側の待ち数も大きくしすぎない。
$server = IO::Socket::INET->new(
    LocalPort => $port,
    Proto     => "tcp",
    Listen    => $backlog,
    Reuse     => 1,
) || die "cannot listen: $!";

print "Server5 start port=$port workers=$workers backlog=$backlog\n";

for ($i = 1; $i <= $workers; $i++) {
#   forkしてworkerを増やす。
    $pid = fork();
    die "cannot fork: $!" unless defined $pid;

    if ($pid == 0) {
#       子プロセスはacceptして処理し続ける。
        while ($client = $server->accept()) {
            $request = read_request($client);
            if ($request eq "") {
                close($client);
                next;
            }

            ($method, $uri, $proto) = split(/ /, $request);
            ($path, $query) = split(/\?/, $uri);

            $query = "" unless defined $query;
            $name = $query;
            $name = $2 if ($query =~ /(^|&)name=([^&]*)/);

            print $client "HTTP/1.0 200 OK\r\n";
            print $client "Content-Type: text/html\r\n";
            print $client "\r\n";
            print $client "<html><body>";
            print $client "<h1>Server5</h1>";
            print $client "<p>$name</p>";
            print $client "<p>worker=$i pid=$$</p>";
            print $client "</body></html>";

            close($client);
        }
        exit;
    }
}

# 親プロセスは子を待つだけ。
while (1) {
    wait();
}

sub read_request {
    ($client) = @_;

#   workerが遅い相手に掴まれっぱなしにならないようにする。
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

#   timeoutや巨大行は返事をせず切る。preforkなのでworkerを守る。
    return "" if ($@);
    return "" if (length($line) > $max_line);
    return $line;
}
