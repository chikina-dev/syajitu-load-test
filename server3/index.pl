#!/usr/bin/perl

use IO::Socket;

$port = 8080;
$memory_mb = 32;
$backlog = 1;

# メモリを多く持っているサーバーということにする。
$big_memory = "x" x ($memory_mb * 1024 * 1024);

# 受付はまだ小さい。アプリ側のqueueは作らない。
$server = IO::Socket::INET->new(
    LocalPort => $port,
    Proto     => "tcp",
    Listen    => $backlog,
    Reuse     => 1,
) || die "cannot listen: $!";

print "Server3 start port=$port memory=$memory_mb MB\n";

while ($client = $server->accept()) {
#   リクエスト行を読む。
    $request = <$client>;
    ($method, $uri, $proto) = split(/ /, $request);
    ($path, $query) = split(/\?/, $uri);

    $query = "" unless defined $query;
    $name = $query;
    $name = $2 if ($query =~ /(^|&)name=([^&]*)/);

#   同じnameなら前に作ったHTMLを返す。雑なメモリcache。
    if ($cache{$name} eq "") {
        $cache{$name} = "<html><body><h1>Server3</h1><p>$name</p></body></html>";
    }

    print $client "HTTP/1.0 200 OK\r\n";
    print $client "Content-Type: text/html\r\n";
    print $client "\r\n";
    print $client $cache{$name};

    close($client);
}
