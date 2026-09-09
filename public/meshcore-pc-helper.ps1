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
Write-Host 'Close the official MeshCore app first — the radio usually allows only one Wi-Fi TCP client.'

$tcp = $null
$stream = $null
$buf = New-Object byte[] 8192

function Close-All {
  if ($stream) { try { $stream.Close() } catch {} }
  if ($tcp) { try { $tcp.Close() } catch {} }
  if ($ws.State -eq [Net.WebSockets.WebSocketState]::Open) {
    try {
      $ws.CloseAsync([Net.WebSockets.WebSocketCloseStatus]::NormalClosure, 'done', $ct).GetAwaiter().GetResult() | Out-Null
    } catch {}
  }
  try { $ws.Dispose() } catch {}
}

function Connect-Radio([string]$radioIp, [int]$radioPort) {
  Write-Host "Opening TCP ${radioIp}:${radioPort} from this PC (IPv4, 8s timeout)..."
  $ip = [Net.IPAddress]::Parse($radioIp)
  if ($ip.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork) {
    throw "Use a dotted IPv4 address, not '$radioIp'."
  }
  $client = New-Object Net.Sockets.TcpClient([Net.Sockets.AddressFamily]::InterNetwork)
  $ar = $client.BeginConnect($ip, $radioPort, $null, $null)
  if (-not $ar.AsyncWaitHandle.WaitOne(8000, $false)) {
    try { $client.Close() } catch {}
    throw "Timed out reaching ${radioIp}:${radioPort}. Disconnect the official MeshCore app from the radio, then try again. Only one TCP client can use companion_radio_wifi at a time."
  }
  try {
    $client.EndConnect($ar)
  } catch {
    throw "Nothing accepted TCP on ${radioIp}:${radioPort}. $($_.Exception.Message)"
  }
  $client.NoDelay = $true
  $client.ReceiveTimeout = 0
  $client.SendTimeout = 20000
  return $client
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
      $text = [Text.Encoding]::UTF8.GetString($payload)
      if ($text -match '"error"\s*:\s*"([^"]*)"') { throw $Matches[1] }
      if ($tcp) { continue }
      $radioIp = $null
      $radioPort = 0
      if ($text -match '"host"\s*:\s*"([^"]+)"') { $radioIp = $Matches[1] }
      if ($text -match '"port"\s*:\s*(\d+)') { $radioPort = [int]$Matches[1] }
      if (-not $radioIp -or $radioPort -lt 1) { continue }
      try {
        $tcp = Connect-Radio $radioIp $radioPort
      } catch {
        Send-Text (@{ error = [string]$_.Exception.Message } | ConvertTo-Json -Compress)
        throw
      }
      $stream = $tcp.GetStream()
      Send-Text '{"ok":true}'
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
