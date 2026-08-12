$ErrorActionPreference = 'Stop'

$lessonProjectRoot = $env:SUPER_EDITOR_LESSON_ENGINE_ROOT
if ([string]::IsNullOrWhiteSpace($lessonProjectRoot)) {
  # Windows PowerShell 5.1 reads UTF-8-without-BOM scripts as ANSI. Build the
  # Chinese folder name from code points so the launcher remains encoding-safe.
  $lessonProjectName = 'ai' + (-join @(
    [char]0x7B80,
    [char]0x5316,
    [char]0x754C,
    [char]0x9762,
    [char]0x578B,
    [char]0x6559,
    [char]0x8F85
  ))
  $lessonProjectRoot = Join-Path 'D:\GIT-web\web-tool' $lessonProjectName
}

if (-not (Test-Path -LiteralPath $lessonProjectRoot -PathType Container)) {
  throw "Lesson engine project root does not exist: $lessonProjectRoot. Set SUPER_EDITOR_LESSON_ENGINE_ROOT to the shared rule project."
}

$lessonProjectRoot = (Resolve-Path -LiteralPath $lessonProjectRoot).Path
$lessonEngineEntry = Join-Path $lessonProjectRoot 'template-engine\mcp-server.js'
$lessonRulesName = -join @([char]0x6A21, [char]0x7248)
$lessonRulesPath = Join-Path $lessonProjectRoot $lessonRulesName

if (-not (Test-Path -LiteralPath $lessonEngineEntry -PathType Leaf)) {
  throw "Lesson engine MCP entry does not exist: $lessonEngineEntry"
}
if (-not (Test-Path -LiteralPath $lessonRulesPath -PathType Container)) {
  throw "Lesson template rule directory does not exist: $lessonRulesPath"
}

Push-Location -LiteralPath $lessonProjectRoot
try {
  & node $lessonEngineEntry
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }
}
finally {
  Pop-Location
}
