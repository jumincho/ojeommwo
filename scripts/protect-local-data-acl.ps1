param(
  [string]$ProjectRoot = (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)),
  [string]$DataDir = "",
  [switch]$VerifyOnly
)

$ErrorActionPreference = "Stop"
if ($PSVersionTable.PSEdition -eq "Core" -and $env:OS -ne "Windows_NT") {
  throw "Windows data ACL protection can run only on Windows."
}

function Resolve-NormalizedPath {
  param([Parameter(Mandatory = $true)][string]$Path)

  $fullPath = [System.IO.Path]::GetFullPath($Path)
  $pathRoot = [System.IO.Path]::GetPathRoot($fullPath)
  if ($fullPath.Length -gt $pathRoot.Length) {
    return $fullPath.TrimEnd([char[]]@('\', '/'))
  }
  return $fullPath
}

$ProjectRoot = Resolve-NormalizedPath -Path $ProjectRoot
if (-not (Test-Path -LiteralPath $ProjectRoot -PathType Container)) {
  throw "Project root is missing: $ProjectRoot"
}
if ((Get-Item -Force -LiteralPath $ProjectRoot).Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
  throw "Data ACL protection refuses a reparse-point project root."
}
if (-not $DataDir) { $DataDir = Join-Path $ProjectRoot "data" }
$DataDir = Resolve-NormalizedPath -Path $DataDir
$ExpectedDataDir = Resolve-NormalizedPath -Path (Join-Path $ProjectRoot "data")
if (-not $DataDir.Equals($ExpectedDataDir, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "DataDir must be exactly ProjectRoot\data; refusing ACL changes outside the managed data directory."
}
if (-not (Test-Path -LiteralPath $DataDir -PathType Container)) {
  throw "Data directory is missing: $DataDir"
}

$entries = @(
  Get-Item -Force -LiteralPath $DataDir
  Get-ChildItem -Force -LiteralPath $DataDir -Recurse
)
if (@($entries | Where-Object { $_.Attributes -band [System.IO.FileAttributes]::ReparsePoint }).Count -gt 0) {
  throw "Data ACL protection refuses reparse points."
}
if (@($entries | Where-Object { -not $_.PSIsContainer -and $_.Name -match '\.(?:lock|tmp|reap)$' }).Count -gt 0) {
  throw "Data ACL protection requires an idle store without lock or temporary files."
}

$currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$systemSid = [System.Security.Principal.SecurityIdentifier]::new("S-1-5-18")
$administratorsSid = [System.Security.Principal.SecurityIdentifier]::new("S-1-5-32-544")
$allowedSids = @($currentSid.Value, $systemSid.Value, $administratorsSid.Value)
$fullControl = [System.Security.AccessControl.FileSystemRights]::FullControl
$allow = [System.Security.AccessControl.AccessControlType]::Allow
$inheritBoth = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor `
  [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
$inheritNone = [System.Security.AccessControl.InheritanceFlags]::None
$propagateNone = [System.Security.AccessControl.PropagationFlags]::None
$fileSystemAclExtensionsAvailable = $null -ne ("System.IO.FileSystemAclExtensions" -as [type])

function Set-PrivateAcl {
  param([System.IO.FileSystemInfo]$Entry)

  if ($Entry.PSIsContainer) {
    $acl = [System.Security.AccessControl.DirectorySecurity]::new()
    $acl.SetOwner($currentSid)
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($sid in @($currentSid, $systemSid, $administratorsSid)) {
      $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
        $sid, $fullControl, $inheritBoth, $propagateNone, $allow
      ))
    }
  } else {
    $acl = [System.Security.AccessControl.FileSecurity]::new()
    $acl.SetOwner($currentSid)
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($sid in @($currentSid, $systemSid, $administratorsSid)) {
      $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
        $sid, $fullControl, $inheritNone, $propagateNone, $allow
      ))
    }
  }
  # PowerShell 5.1's Set-Acl cmdlet can attempt to persist the SACL even when
  # the descriptor only changes its owner and DACL. A normal (non-elevated)
  # operator then receives SeSecurityPrivilege even though audit rules are not
  # part of this contract. Persist the strongly typed descriptor through the
  # Write only the modified owner/DACL sections so a normal operator never
  # needs SACL authority. PowerShell 7/.NET exposes the static extension API;
  # Windows PowerShell 5.1 exposes the equivalent instance API instead.
  if ($fileSystemAclExtensionsAvailable) {
    if ($Entry.PSIsContainer) {
      [System.IO.FileSystemAclExtensions]::SetAccessControl(
        [System.IO.DirectoryInfo]$Entry, $acl
      )
    } else {
      [System.IO.FileSystemAclExtensions]::SetAccessControl(
        [System.IO.FileInfo]$Entry, $acl
      )
    }
  } elseif ($Entry.PSIsContainer) {
    ([System.IO.DirectoryInfo]$Entry).SetAccessControl($acl)
  } else {
    ([System.IO.FileInfo]$Entry).SetAccessControl($acl)
  }
}

function Assert-PrivateAcl {
  param([System.IO.FileSystemInfo]$Entry)

  $acl = Get-Acl -LiteralPath $Entry.FullName
  $isDataRoot = $Entry.FullName.Equals($DataDir, [System.StringComparison]::OrdinalIgnoreCase)
  if ($isDataRoot -and -not $acl.AreAccessRulesProtected) {
    throw "Data root ACL inheritance remains enabled: $($Entry.FullName)"
  }
  $ownerSid = $acl.Owner
  try {
    $ownerSid = ([System.Security.Principal.NTAccount]$acl.Owner).Translate(
      [System.Security.Principal.SecurityIdentifier]
    ).Value
  } catch {
    try {
      $ownerSid = ([System.Security.Principal.SecurityIdentifier]$acl.Owner).Value
    } catch {
      throw "ACL owner cannot be resolved: $($Entry.FullName)"
    }
  }
  if ($ownerSid -notin $allowedSids) {
    throw "ACL owner is not an authorized operator/System/Administrators principal: $($Entry.FullName)"
  }

  $rules = @($acl.Access)
  if ($rules.Count -ne $allowedSids.Count) {
    throw "ACL must contain exactly owner/System/Administrators rules: $($Entry.FullName)"
  }
  $seenSids = @{}
  foreach ($rule in $rules) {
    if ($acl.AreAccessRulesProtected -and $rule.IsInherited) {
      throw "Protected ACL contains an inherited rule: $($Entry.FullName)"
    }
    if (-not $acl.AreAccessRulesProtected -and -not $rule.IsInherited) {
      throw "Inheriting ACL contains an explicit rule: $($Entry.FullName)"
    }
    if ($rule.AccessControlType -ne $allow) { throw "Unexpected deny ACL: $($Entry.FullName)" }
    try {
      $sid = $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
    } catch {
      throw "ACL contains an unresolvable principal: $($Entry.FullName)"
    }
    if ($sid -notin $allowedSids -or $seenSids.ContainsKey($sid)) {
      throw "Unexpected or duplicate ACL principal on $($Entry.FullName): $sid"
    }
    $seenSids[$sid] = $true
    if ([int64]$rule.FileSystemRights -ne [int64]$fullControl) {
      throw "ACL principal lacks exact FullControl on $($Entry.FullName): $sid"
    }
    $expectedInheritance = if ($Entry.PSIsContainer) { $inheritBoth } else { $inheritNone }
    if ($rule.InheritanceFlags -ne $expectedInheritance -or $rule.PropagationFlags -ne $propagateNone) {
      throw "ACL inheritance flags are invalid on $($Entry.FullName): $sid"
    }
  }
  foreach ($sid in $allowedSids) {
    if (-not $seenSids.ContainsKey($sid)) {
      throw "ACL is missing an authorized principal on $($Entry.FullName): $sid"
    }
  }
}

if (-not $VerifyOnly) {
  # Protect the root first so files created after this point inherit only the
  # owner/System/Administrators rules, then normalize every pre-existing entry.
  Set-PrivateAcl -Entry $entries[0]
  foreach ($entry in $entries | Select-Object -Skip 1) { Set-PrivateAcl -Entry $entry }
}

foreach ($entry in $entries) {
  Assert-PrivateAcl -Entry $entry
}

$mode = if ($VerifyOnly) { "verification" } else { "protection" }
Write-Output "Local data ACL $mode passed: $($entries.Count) entries; exact owner/System/Administrators FullControl only."
