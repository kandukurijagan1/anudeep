$desktopDir = [System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::Desktop)
$projectDir = if ($PSScriptRoot) { $PSScriptRoot } else { "C:\Users\ADMIN\Desktop\anudeep-kadir-bandi" }
$iconPath = Join-Path $projectDir "icon.ico"
$shortcutPath = Join-Path $desktopDir "Anudeep Khadi Bandar - GST Billing.lnk"

# Always use the launcher script so we get the Electron app
$launcherBat = Join-Path $projectDir "Launch-AKB-App.bat"
$targetPath = $launcherBat

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
