# A Windows toast whose progress bar moves.
#
# Reads one JSON object per line on stdin and drives a single adaptive toast:
#
#   {"op":"show","tag":"...","title":"...","status":"...","value":0.0,"detail":"..."}
#   {"op":"update","tag":"...","status":"...","value":0.42,"detail":"..."}
#   {"op":"finish","tag":"...","title":"...","status":"...","detail":"..."}
#
# Why a long-lived process rather than one PowerShell per update: starting
# PowerShell costs a couple of hundred milliseconds, and this is asked to move a
# progress bar. It stays open for the life of the server.
#
# Why `Update()` rather than showing a new toast: showing again re-raises the
# banner, which is the flicker this exists to avoid. `Update()` rewrites the
# bound values of a toast already in the Action Center, silently and in place.
# That is the mechanism behind the answer "yes, Windows has this".
#
# The AUMID is PowerShell's own. An unpackaged program has no identity of its
# own to notify under, and borrowing the shell's is the documented way to send a
# toast without shipping an installer.

$ErrorActionPreference = 'Stop'
$AUMID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'

[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] > $null
[Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType=WindowsRuntime] > $null
[Windows.UI.Notifications.NotificationData, Windows.UI.Notifications, ContentType=WindowsRuntime] > $null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType=WindowsRuntime] > $null

# Read stdin as UTF-8 rather than through `[Console]::In`, which uses the
# console's own codepage: on a German Windows that is cp1252, and an ellipsis
# came out as "ÔÇª". Any umlaut in a filename would have gone the same way.
$stdin = New-Object System.IO.StreamReader(
    [Console]::OpenStandardInput(),
    (New-Object System.Text.UTF8Encoding $false)
)

$notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($AUMID)
$group = 'hexscribe'
$sequence = @{}

# `{bindings}` are filled from NotificationData, which is what makes an update
# possible at all: the XML is registered once and only the values change.
$progressXml = @'
<toast launch="hexscribe">
  <visual>
    <binding template="ToastGeneric">
      <text>hexscribe</text>
      <progress title="{title}" value="{value}" valueStringOverride="{valueString}" status="{status}"/>
    </binding>
  </visual>
</toast>
'@

function New-Data([hashtable]$values, [uint32]$seq) {
    # Built from a .NET dictionary rather than by indexing `.Values`: the WinRT
    # map projection is not usable from Windows PowerShell, but this constructor
    # overload is.
    $dict = New-Object 'System.Collections.Generic.Dictionary[string,string]'
    foreach ($key in $values.Keys) { $dict.Add($key, [string]$values[$key]) }
    $data = New-Object Windows.UI.Notifications.NotificationData($dict)
    $data.SequenceNumber = $seq
    return $data
}

function Next-Sequence([string]$tag) {
    if (-not $sequence.ContainsKey($tag)) { $sequence[$tag] = 0 }
    $sequence[$tag] = $sequence[$tag] + 1
    return [uint32]$sequence[$tag]
}

function Show-Progress($message) {
    $doc = New-Object Windows.Data.Xml.Dom.XmlDocument
    $doc.LoadXml($progressXml)
    $toast = New-Object Windows.UI.Notifications.ToastNotification $doc
    $toast.Tag = $message.tag
    $toast.Group = $group
    # It belongs in the Action Center while the run is going, not as a banner
    # that steals focus every time.
    $toast.SuppressPopup = $false
    $toast.Data = New-Data @{
        title       = $message.title
        value       = ([string]$message.value)
        valueString = $message.detail
        status      = $message.status
    } (Next-Sequence $message.tag)
    $notifier.Show($toast)
}

function Update-Progress($message) {
    $data = New-Data @{
        value       = ([string]$message.value)
        valueString = $message.detail
        status      = $message.status
    } (Next-Sequence $message.tag)
    $result = $notifier.Update($data, $message.tag, $group)
    if ($result -ne 'Succeeded') {
        # The toast was dismissed, so there is nothing to update. Put it back.
        Show-Progress $message
    }
}

function Show-Finished($message) {
    # A plain toast, no progress element: the run is over and a bar sitting at
    # 100% for an hour afterwards is clutter.
    $doc = New-Object Windows.Data.Xml.Dom.XmlDocument
    $xml = @"
<toast launch="hexscribe">
  <visual>
    <binding template="ToastGeneric">
      <text>$([System.Security.SecurityElement]::Escape($message.title))</text>
      <text>$([System.Security.SecurityElement]::Escape($message.detail))</text>
    </binding>
  </visual>
</toast>
"@
    $doc.LoadXml($xml)
    $toast = New-Object Windows.UI.Notifications.ToastNotification $doc
    $toast.Tag = $message.tag
    $toast.Group = $group
    $notifier.Show($toast)
}

while ($null -ne ($line = $stdin.ReadLine())) {
    if (-not $line.Trim()) { continue }
    try {
        $message = $line | ConvertFrom-Json
        switch ($message.op) {
            'show'   { Show-Progress   $message }
            'update' { Update-Progress $message }
            'finish' { Show-Finished   $message }
            'hide'   { [Windows.UI.Notifications.ToastNotificationManager]::History.Remove($message.tag, $group, $AUMID) }
        }
    } catch {
        # One malformed line, or one toast the shell refused, must not end the
        # process: the server keeps writing and expects somebody to be reading.
        [Console]::Error.WriteLine("toast: $($_.Exception.Message)")
    }
}
