#!/usr/bin/perl

use IO::Socket;

$port = 8080;

# 最初のサーバー。とにかく1個ずつ処理する。
$server = IO::Socket::INET->new(
    LocalPort => $port,
    Proto     => "tcp",
    Listen    => 1,
    Reuse     => 1,
) || die "cannot listen: $!";

print "Server1 start port=$port\n";

while ($client = $server->accept()) {
#   1行目だけ読む。ヘッダは読まない。
    $request = <$client>;
    ($method, $uri, $proto) = split(/ /, $request);
    ($path, $query) = split(/\?/, $uri);

#   GETのnameをそのまま取り出す。
    $query = "" unless defined $query;
    $name = $query;
    $name = $2 if ($query =~ /(^|&)name=([^&]*)/);

#   HTTP/1.0でそのまま返す。
    print $client "HTTP/1.0 200 OK\r\n";
    print $client "Content-Type: text/html\r\n";
    print $client "\r\n";
    print $client "<html><body>";
    print $client "<h1>Server1</h1>";
    print $client "<p>$name</p>";
    print $client "</body></html>";

    close($client);
}
