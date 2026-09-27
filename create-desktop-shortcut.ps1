$desktopDir = [System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::Desktop)
$projectDir = if ($PSScriptRoot) { $PSScriptRoot } else { "C:\Users\ADMIN\Desktop\anudeep-kadir-bandi" }
$iconPath = Join-Path $projectDir "icon.ico"
$shortcutPath = Join-Path $desktopDir "Anudeep Khadi Bandar - GST Billing.lnk"

# Select best executable target
$packagedExe = Join-Path $projectDir "dist\AKB-Billing-win32-x64\AKB-Billing.exe"
$nativeExe = Join-Path $projectDir "AKB-Billing.exe"
$launcherBat = Join-Path $projectDir "Launch-AKB-App.bat"

if (Test-Path $packagedExe) {
    $targetPath = $packagedExe
} elseif (Test-Path $nativeExe) {
    $targetPath = $nativeExe
} else {
    $targetPath = $launcherBat
}

$wsh = New-Object -ComObject WScript.Shell
$sc = $wsh.CreateShortcut($shortcutPath)
$sc.TargetPath = $targetPath
$sc.WorkingDirectory = $projectDir
if (Test-Path $iconPath) {
    $sc.IconLocation = "$iconPath,0"
}
$sc.Description = "Anudeep Khadi Bandar - Dedicated GST Billing Workstation"
$sc.Save()

Write-Host "✅ Dedicated App Desktop shortcut created successfully at: $shortcutPath"
Write-Host "   Target: $targetPath"
