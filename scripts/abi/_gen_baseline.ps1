# Generates scripts/abi/abi-baseline.json using the SAME extraction algorithm as
# check-abi-compatibility.mjs (node unavailable on this machine). Temporary tooling.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$root = Split-Path -Parent $root

function Find-MatchingBrace([string]$src, [int]$openIdx) {
    $depth = 0
    for ($i = $openIdx; $i -lt $src.Length; $i++) {
        if ($src[$i] -eq '{') { $depth++ }
        elseif ($src[$i] -eq '}') { $depth--; if ($depth -eq 0) { return $i } }
    }
    return -1
}

function Extract-Version([string]$src) {
    if ($src -match 'const\s+CONTRACT_VERSION\s*:\s*&str\s*=\s*"([^"]+)"') { return $Matches[1] }
    return $null
}

function Extract-Errors([string]$src) {
    $attrIdx = $src.IndexOf('#[contracterror]')
    if ($attrIdx -eq -1) { return @() }
    $enumIdx = $src.IndexOf('pub enum', $attrIdx)
    $brace = $src.IndexOf('{', $enumIdx)
    $close = Find-MatchingBrace $src $brace
    $body = $src.Substring($brace + 1, $close - $brace - 1)
    $results = @()
    foreach ($m in [regex]::Matches($body, '(?m)^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(\d+)\s*,?')) {
        $results += ,@($m.Groups[1].Value, [int]$m.Groups[2].Value)
    }
    return ,$results
}

function Extract-Methods([string]$src) {
    $methods = New-Object System.Collections.Generic.List[string]
    $searchFrom = 0
    while ($true) {
        $attrIdx = $src.IndexOf('#[contractimpl]', $searchFrom)
        if ($attrIdx -eq -1) { break }
        $searchFrom = $attrIdx + 15
        $implIdx = $src.IndexOf('impl', $searchFrom)
        if ($implIdx -eq -1) { break }
        $brace = $src.IndexOf('{', $implIdx)
        if ($brace -eq -1) { break }
        $close = Find-MatchingBrace $src $brace
        if ($close -eq -1) { break }
        $body = $src.Substring($brace + 1, $close - $brace - 1)
        foreach ($m in [regex]::Matches($body, '(?m)^\s*pub\s+fn\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(')) {
            $depth = 1
            foreach ($ch in $body.Substring(0, $m.Index).ToCharArray()) {
                if ($ch -eq '{') { $depth++ } elseif ($ch -eq '}') { $depth-- }
            }
            if ($depth -eq 1) { $methods.Add($m.Groups[1].Value) | Out-Null }
        }
        $searchFrom = $close + 1
    }
    return @($methods | Sort-Object -Unique)
}

$abi = Get-Content (Join-Path $root 'packages/contract-abi/abi.json') -Raw | ConvertFrom-Json

$contracts = @(
    ,@('marketplace', @('contracts/soroban-marketplace/src/contract.rs', 'contracts/soroban-marketplace/src/types.rs'))
    ,@('launchpad',   @('contracts/launchpad/src/contract.rs', 'contracts/launchpad/src/types.rs'))
)

$report = New-Object System.Collections.Generic.List[string]
$baselineJson = New-Object System.Collections.Generic.List[string]
$baselineJson.Add('{')
$baselineJson.Add('  "_comment": "Known ABI deviations accepted by scripts/abi/check-abi-compatibility.mjs. New deviations fail CI; shrink this file as abi.json catches up.",')

$firstContract = $true
foreach ($c in $contracts) {
    $key = $c[0]
    $src = ''
    foreach ($f in $c[1]) { $src += (Get-Content (Join-Path $root $f) -Raw) + "`n" }
    $errs = Extract-Errors $src
    $methods = Extract-Methods $src
    $abiC = $abi.contracts.$key

    # Deviations (mirrors .mjs logic)
    $abiErrNames = @($abiC.errors.PSObject.Properties.Name)
    $rustErrNames = @($errs | ForEach-Object { $_[0] })
    $missingE = @($errs | Where-Object { $_ -notin $abiErrNames } | ForEach-Object { "$($_[0])=$($_[1])" } | Sort-Object -Unique)
    $staleE = @($abiErrNames | Where-Object { $_ -notin $rustErrNames } | Sort-Object -Unique)

    $abiM = @($abiC.methods | ForEach-Object { $_.name })
    $missingM = @($methods | Where-Object { $_ -notin $abiM } | Sort-Object -Unique)
    $staleM = @($abiM | Where-Object { $_ -notin $methods } | Sort-Object -Unique)

    $report.Add("=== $key ===")
    $report.Add("  missingMethodsInAbi ($($missingM.Count))")
    $report.Add("  staleMethodsInAbi ($($staleM.Count)): $($staleM -join ', ')")
    $report.Add("  missingErrorsInAbi ($($missingE.Count)): $($missingE -join ', ')")
    $report.Add("  staleErrorsInAbi ($($staleE.Count)): $($staleE -join ', ')")

    # Emit JSON block
    if (-not $firstContract) { $baselineJson.Add(',') }
    $firstContract = $false
    $baselineJson.Add("  `"$key`": {")
    $baselineJson.Add('    "missingMethodsInAbi": [')
    $mmLines = foreach ($m in $missingM) { "      `"$m`"" }
    $baselineJson.Add(($mmLines -join ",`n"))
    $baselineJson.Add('    ],')
    $baselineJson.Add('    "staleMethodsInAbi": [')
    $smLines = foreach ($m in $staleM) { "      `"$m`"" }
    $baselineJson.Add(($smLines -join ",`n"))
    $baselineJson.Add('    ],')
    $baselineJson.Add('    "missingErrorsInAbi": [')
    $meLines = foreach ($m in $missingE) { "      `"$m`"" }
    $baselineJson.Add(($meLines -join ",`n"))
    $baselineJson.Add('    ],')
    $baselineJson.Add('    "staleErrorsInAbi": [')
    $seLines = foreach ($m in $staleE) { "      `"$m`"" }
    $baselineJson.Add(($seLines -join ",`n"))
    $baselineJson.Add('    ],')
    $baselineJson.Add('    "mismatchedErrors": []')
    $baselineJson.Add('  }')
}
$baselineJson.Add('}')

$baselinePath = Join-Path $PSScriptRoot 'abi-baseline.json'
$baselineJson -join "`n" | Set-Content $baselinePath -Encoding ASCII
$report | Set-Content (Join-Path $env:TEMP 'abi-gen-report.txt') -Encoding UTF8
Write-Host "WROTE $baselinePath"