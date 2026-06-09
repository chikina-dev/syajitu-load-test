#!/usr/bin/perl

use IO::Socket;

$port = 8080;
$window = 10;
$max_recent = 60;
$drop_recent = 120;
$backlog = 4;

# nofile=32なので、Rate Limitはかなり余裕を持たせる。
# ここは制限を見せるサーバーなので、少し超えた分だけ503にする。
$server = IO::Socket::INET->new(
    LocalPort => $port,
    Proto     => "tcp",
    Listen    => $backlog,
    Reuse     => 1,
) || die "cannot listen: $!";

print "Server2 start port=$port max_recent=$max_recent/$window sec\n";

while ($client = $server->accept()) {
#   接続元IPごとの古いアクセス時刻を持っておく。
    $ip = $client->peerhost;
    $now = time;

    @old = split(/,/, $access{$ip});
    @new = ();
    foreach $t (@old) {
        push(@new, $t) if ($t > $now - $window);
    }

    push(@new, $now);
    $access{$ip} = join(",", @new);

    if (@new > $drop_recent) {
#       あまりに多い相手は返事もせずに切る。昔のすぐ落ちる感じ。
        close($client);
        next;
    }

    if (@new > $max_recent) {
#       上限を少し超えた分だけ503で返す。429みたいな今風のことはしない。
        print $client "HTTP/1.0 503 Service Unavailable\r\n";
        print $client "Content-Type: text/html\r\n";
        print $client "\r\n";
        print $client "<html><body>";
        print $client "<h1>Server2</h1>";
        print $client "<p>rate limit</p>";
        print $client "</body></html>";
        close($client);
        next;
    }

#   ここから普通のServer1と同じような処理。
    $request = <$client>;
    ($method, $uri, $proto) = split(/ /, $request);
    ($path, $query) = split(/\?/, $uri);

    $query = "" unless defined $query;
    $name = $query;
    $name = $2 if ($query =~ /(^|&)name=([^&]*)/);

    print $client "HTTP/1.0 200 OK\r\n";
    print $client "Content-Type: text/html\r\n";
    print $client "\r\n";
    print $client "<html><body>";
    print $client "<h1>Server2</h1>";
    print $client "<p>$name</p>";
    print $client "</body></html>";

    close($client);
}
