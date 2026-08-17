# Downloads the model assets hexscribe needs. They are gitignored (~350 MB).
#
#   .\scripts\fetch-models.ps1
#
# The Whisper asset is a *precompiled QNN context binary* built for HTP v73
# (Snapdragon X Elite / X Plus share that NPU). It is not portable to other
# chipsets -- for those, pick a different asset from
# https://huggingface.co/qualcomm/Whisper-Small-Quantized

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$models = Join-Path $root 'models'
New-Item -ItemType Directory -Force $models | Out-Null

$assetUrl = 'https://qaihub-public-assets.s3.us-west-2.amazonaws.com/qai-hub-models/models/whisper_small_quantized/releases/v0.60.0/whisper_small_quantized-precompiled_qnn_onnx-w8a16-qualcomm_snapdragon_x_elite.zip'
$zip = Join-Path $models 'whisper_small_qnn_xelite.zip'
$modelDir = Join-Path $models 'whisper-small-qnn'

if (-not (Test-Path $modelDir)) {
    Write-Host "downloading whisper-small (w8a16, QNN precompiled) ..."
    Invoke-WebRequest -Uri $assetUrl -OutFile $zip
    Expand-Archive -Path $zip -DestinationPath $modelDir -Force
    Remove-Item $zip
} else {
    Write-Host "model already present: $modelDir"
}

# The asset ships graphs only; the tokenizer comes from the original model.
$tokenizerDir = Join-Path $models 'whisper-small-tokenizer'
$tokenizer = Join-Path $tokenizerDir 'tokenizer.json'
if (-not (Test-Path $tokenizer)) {
    Write-Host "downloading whisper tokenizer ..."
    New-Item -ItemType Directory -Force $tokenizerDir | Out-Null
    Invoke-WebRequest -Uri 'https://huggingface.co/openai/whisper-small/resolve/main/tokenizer.json' -OutFile $tokenizer
} else {
    Write-Host "tokenizer already present: $tokenizer"
}

# --- speaker diarization (optional, ~35 MB) --------------------------------
# Pure ONNX: pyannote segmentation-3.0 finds speech regions, a speaker-embedding
# network vectorises them, clustering groups the vectors. Both run on the CPU --
# neither has a QAIRT context binary, so diarization does not touch the NPU.

$sherpa = 'https://github.com/k2-fsa/sherpa-onnx/releases/download'
$segDir = Join-Path $models 'sherpa-onnx-pyannote-segmentation-3-0'
if (-not (Test-Path $segDir)) {
    Write-Host "downloading pyannote segmentation ..."
    $archive = Join-Path $models 'segmentation.tar.bz2'
    Invoke-WebRequest -Uri "$sherpa/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2" -OutFile $archive
    tar -xjf $archive -C $models
    Remove-Item $archive
} else {
    Write-Host "segmentation model already present"
}

$embedding = Join-Path $models 'wespeaker_en_voxceleb_CAM++.onnx'
if (-not (Test-Path $embedding)) {
    Write-Host "downloading speaker embedding model ..."
    # '+' must stay percent-encoded in the URL or the CDN 404s.
    Invoke-WebRequest -Uri "$sherpa/speaker-recongition-models/wespeaker_en_voxceleb_CAM%2B%2B.onnx" -OutFile $embedding
} else {
    Write-Host "embedding model already present"
}

# The embedding model for the default (utterance-level) diarizer. A different
# one on purpose: the English VoxCeleb model above is not usable on this
# project's own recordings -- measured, it put two halves of one German speaker
# further apart (0.89) than two different English speakers (0.49). This one was
# the only candidate of five whose within-speaker distances all fell below its
# between-speaker distances on both test fixtures.
$utterance = Join-Path $models '3dspeaker_campplus_sv_zh_en.onnx'
if (-not (Test-Path $utterance)) {
    Write-Host "downloading multilingual speaker embedding model ..."
    Invoke-WebRequest -Uri "$sherpa/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx" -OutFile $utterance
} else {
    Write-Host "utterance embedding model already present"
}

Write-Host "done. Next: cd py; uv sync; cd ..; npm install; .\hexscribe.ps1 <audio-file>"
