# Windows PowerShell module auto-loading can be unavailable in isolated test
# and emergency environments. Supply the one hashing primitive these scripts
# require without weakening path or algorithm handling.
if ($null -eq (Get-Command Get-FileHash -ErrorAction SilentlyContinue)) {
  function global:Get-FileHash {
    [CmdletBinding()]
    param(
      [Parameter(Mandatory = $true)][string]$LiteralPath,
      [ValidateSet("SHA256")][string]$Algorithm = "SHA256"
    )

    $ResolvedPath = (Resolve-Path -LiteralPath $LiteralPath -ErrorAction Stop).Path
    $Stream = [System.IO.File]::Open(
      $ResolvedPath,
      [System.IO.FileMode]::Open,
      [System.IO.FileAccess]::Read,
      [System.IO.FileShare]::Read
    )
    $Hasher = [System.Security.Cryptography.SHA256]::Create()
    try {
      $Hash = [System.BitConverter]::ToString($Hasher.ComputeHash($Stream)).Replace("-", "")
    } finally {
      $Hasher.Dispose()
      $Stream.Dispose()
    }
    [pscustomobject]@{
      Algorithm = $Algorithm
      Hash = $Hash
      Path = $ResolvedPath
    }
  }
}
