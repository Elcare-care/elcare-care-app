# Temporary cross-check of check-abi-compatibility.mjs extraction logic (no node/python on machine).
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$root = Split-Path -Parent $root
$out = New-Object System.Collections.Generic.List[string]

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

foreach ($c in $contracts) {
    $key = $c[0]
    $src = ''
    foreach ($f in $c[1]) { $src += (Get-Content (Join-Path $root $f) -Raw) + "`n" }
    $ver = Extract-Version $src
    $errs = Extract-Errors $src
    $methods = Extract-Methods $src
    $abiC = $abi.contracts.$key
    $out.Add("=== $key ===")
    $sync = if ($ver -eq $abiC.version) { 'YES' } else { 'NO' }
    $out.Add("  rust version=$ver  abi version=$($abiC.version)  sync=$sync")
    $maxCode = if ($errs.Count -gt 0) { ($errs | ForEach-Object { $_[1] } | Measure-Object -Maximum).Maximum } else { '-' }
    $out.Add("  rust errors=$($errs.Count) (max code $maxCode)  abi errors=$(@($abiC.errors.PSObject.Properties).Count)")
    $rustErrNames = $errs | ForEach-Object { $_[0] }
    $abiErrNames = @($abiC.errors.PSObject.Properties.Name)
    $missingE = @($rustErrNames | Where-Object { $_ -notin $abiErrNames })
    $staleE = @($abiErrNames | Where-Object { $_ -notin $rustErrNames })
    $out.Add("  errors missing in abi ($($missingE.Count)): $($missingE[0..([Math]::Min(7,$missingE.Count-1))] -join ', ')")
    $out.Add("  errors stale in abi ($($staleE.Count)): $($staleE[0..([Math]::Min(7,$staleE.Count-1))] -join ', ')")
    $abiM = @($abiC.methods | ForEach-Object { $_.name })
    $missingM = @($methods | Where-Object { $_ -notin $abiM })
    $staleM = @($abiM | Where-Object { $_ -notin $methods })
    $out.Add("  rust methods=$($methods.Count)  abi methods=$($abiM.Count)")
    $out.Add("  methods missing in abi ($($missingM.Count)): $($missingM -join ', ')")
    $out.Add("  methods stale in abi ($($staleM.Count)): $($staleM -join ', ')")
    $out.Add('')
}
$outPath = Join-Path $env:TEMP 'abi-extract-check.txt'
$out | Set-Content $outPath -Encoding UTF8
Write-Host "WROTE $outPath"