#!/usr/bin/perl

use IO::Socket;

$port = 8080;

# 分類するだけ。queueはまだ作らない。
$server = IO::Socket::INET->new(
    LocalPort => $port,
    Proto     => "tcp",
    Listen    => 1,
    Reuse     => 1,
) || die "cannot listen: $!";

print "Server6 start port=$port\n";

while ($client = $server->accept()) {
#   受けたリクエストをその場で分類する。
    $request = <$client>;
    ($method, $uri, $proto) = split(/ /, $request);
    ($path, $query) = split(/\?/, $uri);

    $query = "" unless defined $query;
    $name = $query;
    $name = $2 if ($query =~ /(^|&)name=([^&]*)/);

#   nameで雑に分類する。
    $class = "normal";
    $class = "vip" if ($name =~ /^vip/ || $name =~ /^admin/);
    $class = "slow" if ($name =~ /^slow/ || $path =~ /^\/slow/);

    old_reply($client, "Server6", "$name</p><p>class=$class");
}

sub old_reply {
    ($client, $server_name, $text) = @_;

#   共通の古いHTML返却。
    print $client "HTTP/1.0 200 OK\r\n";
    print $client "Content-Type: text/html\r\n";
    print $client "\r\n";
    print $client "<html><body>";
    print $client "<h1>$server_name</h1>";
    print $client "<p>$text</p>";
    print $client "</body></html>";
    close($client);
}
