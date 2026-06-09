#!/usr/bin/perl

use IO::Socket;
use IO::Select;

$port = 8080;
$max_queue = 16;

# ここから初めてアプリ側の待ち行列を持つ。
$server = IO::Socket::INET->new(
    LocalPort => $port,
    Proto     => "tcp",
    Listen    => 5,
    Reuse     => 1,
) || die "cannot listen: $!";

$select = IO::Select->new($server);

print "Server4 start port=$port queue=$max_queue\n";

while (1) {
#   まず入ってきた接続をqueueに積む。
    @ready = $select->can_read(0.05);
    foreach $sock (@ready) {
        $client = $sock->accept();
        next unless $client;

        if (@queue >= $max_queue) {
#           queueがいっぱいならすぐ落とす。
            print $client "HTTP/1.0 503 Service Unavailable\r\n";
            print $client "Content-Type: text/html\r\n";
            print $client "\r\n";
            print $client "<html><body><h1>Server4</h1><p>queue full</p></body></html>";
            close($client);
        } else {
            push(@queue, $client);
        }
    }

    next unless @queue;

#   古い順に1個だけ取り出して処理する。
    $client = shift(@queue);

#   queueから出たあとでリクエストを読む。
    $request = <$client>;
    ($method, $uri, $proto) = split(/ /, $request);
    ($path, $query) = split(/\?/, $uri);

    $query = "" unless defined $query;
    $name = $query;
    $name = $2 if ($query =~ /(^|&)name=([^&]*)/);

#   queueで粘るが、処理自体はまだ1個ずつ。
    print $client "HTTP/1.0 200 OK\r\n";
    print $client "Content-Type: text/html\r\n";
    print $client "\r\n";
    print $client "<html><body>";
    print $client "<h1>Server4</h1>";
    print $client "<p>$name</p>";
    print $client "</body></html>";

    close($client);
}
