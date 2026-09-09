param(
  [Parameter(Mandatory = $true)][string]$Session,
  [Parameter(Mandatory = $true)][string]$Url
)

$ErrorActionPreference = 'Stop'
$ws = [System.Net.WebSockets.ClientWebSocket]::new()
$ct = [Threading.CancellationToken]::None
Write-Host "Connecting helper to $Url ..."
if ($Url -notmatch '[?&]session=') {
  $join = '?'
  if ($Url.Contains('?')) { $join = '&' }
  $Url = "$Url${join}role=agent&session=$Session"
}
[void]$ws.ConnectAsync([Uri]$Url, $ct).GetAwaiter().GetResult()

function Send-Ws([byte[]]$bytes, [Net.WebSockets.WebSocketMessageType]$type) {
  $seg = [ArraySegment[byte]]::new($bytes)
  $ws.SendAsync($seg, $type, $true, $ct).GetAwaiter().GetResult() | Out-Null
}

function Send-Text([string]$text) {
  Send-Ws ([Text.Encoding]::UTF8.GetBytes($text)) ([Net.WebSockets.WebSocketMessageType]::Text)
}

Write-Host 'Helper is waiting for the browser. Leave this window open.'

$tcp = $null
$stream = $null
$buf = New-Object byte[] 8192

function Close-All {
  if ($stream) { try { $stream.Close() } catch {} }
  if ($tcp) { try { $tcp.Close() } catch {} }
  try { $ws.Abort() } catch {}
}

try {
  while ($ws.State -eq [Net.WebSockets.WebSocketState]::Open) {
    $ms = New-Object IO.MemoryStream
    do {
      $seg = [ArraySegment[byte]]::new($buf)
      $result = $ws.ReceiveAsync($seg, $ct).GetAwaiter().GetResult()
      if ($result.MessageType -eq [Net.WebSockets.WebSocketMessageType]::Close) {
        Close-All
        return
      }
      $ms.Write($buf, 0, $result.Count)
    } while (-not $result.EndOfMessage)
    $payload = $ms.ToArray()

    if ($result.MessageType -eq [Net.WebSockets.WebSocketMessageType]::Text) {
      $msg = [Text.Encoding]::UTF8.GetString($payload) | ConvertFrom-Json
      if ($msg.error) { throw [string]$msg.error }
      if ($tcp) { continue }
      $hostName = [string]$msg.host
      $port = [int]$msg.port
      if (-not $hostName) { continue }
      Write-Host "Opening TCP $hostName`:$port from this PC..."
      $tcp = New-Object Net.Sockets.TcpClient
      $tcp.ReceiveTimeout = 20000
      $tcp.SendTimeout = 20000
      try {
        $tcp.Connect($hostName, $port)
      } catch {
        Send-Text (@{ error = "This PC could not reach $hostName`:$port. $($_.Exception.Message)" } | ConvertTo-Json -Compress)
        Close-All
        throw
      }
      $stream = $tcp.GetStream()
      Send-Text (@{ ok = $true } | ConvertTo-Json -Compress)
      $rs = [runspacefactory]::CreateRunspace()
      $rs.Open()
      $rs.SessionStateProxy.SetVariable('stream', $stream)
      $rs.SessionStateProxy.SetVariable('ws', $ws)
      $pshell = [powershell]::Create()
      $pshell.Runspace = $rs
      [void]$pshell.AddScript({
        $rbuf = New-Object byte[] 4096
        $token = [Threading.CancellationToken]::None
        try {
          while ($true) {
            $n = $stream.Read($rbuf, 0, $rbuf.Length)
            if ($n -le 0) { break }
            $copy = New-Object byte[] $n
            [Array]::Copy($rbuf, $copy, $n)
            $seg = [ArraySegment[byte]]::new($copy)
            $ws.SendAsync($seg, [Net.WebSockets.WebSocketMessageType]::Binary, $true, $token).GetAwaiter().GetResult() | Out-Null
          }
        } catch { }
      })
      [void]$pshell.BeginInvoke()
    } elseif ($tcp -and $stream) {
      $stream.Write($payload, 0, $payload.Length)
    }
  }
} finally {
  Close-All
}
