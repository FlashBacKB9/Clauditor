# Genera locuciones provisionales con las voces de Windows (sin internet).
# Uso: powershell -File voz_tts.ps1 -Lista lista.json -Voz Pablo
#   lista.json = [{ "archivo": "ruta.wav", "texto": "..." }, ...]
param([string]$Lista, [string]$Voz = "Pablo", [double]$Velocidad = 1.0)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media.SpeechSynthesis, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime]

# Espera una IAsyncOperation de WinRT desde PowerShell 5.1
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq "AsTask" -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq "IAsyncOperation``1" } | Select-Object -First 1
function Esperar($op, [Type]$tipo) {
  $t = $asTask.MakeGenericMethod($tipo).Invoke($null, @($op))
  $t.Wait() | Out-Null
  $t.Result
}

$synth = New-Object Windows.Media.SpeechSynthesis.SpeechSynthesizer
$v = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices | Where-Object { $_.DisplayName -match $Voz } | Select-Object -First 1
if ($v) { $synth.Voice = $v }
$synth.Options.SpeakingRate = $Velocidad

foreach ($x in (Get-Content $Lista -Raw -Encoding UTF8 | ConvertFrom-Json)) {
  $stream = Esperar ($synth.SynthesizeTextToStreamAsync($x.texto)) ([Windows.Media.SpeechSynthesis.SpeechSynthesisStream])
  $lector = New-Object Windows.Storage.Streams.DataReader($stream.GetInputStreamAt(0))
  $n = [uint32]$stream.Size
  $null = Esperar ($lector.LoadAsync($n)) ([uint32])
  $bytes = New-Object byte[] $n
  $lector.ReadBytes($bytes)
  [System.IO.File]::WriteAllBytes($x.archivo, $bytes)
  Write-Output ("ok " + $x.archivo)
}
