# Картинки установщика Windows (NSIS) из build/icon.png:
#   build/icon.ico               — иконка установщика и деинсталлятора (16…256 px)
#   build/installerSidebar.bmp   — боковая панель первого и последнего экранов (164×314)
#   build/installerHeader.bmp    — шапка остальных экранов (150×57)
# Запуск: powershell -ExecutionPolicy Bypass -File tools/installer-art.ps1
Add-Type -AssemblyName System.Drawing
$root = Split-Path -Parent $PSScriptRoot
$build = Join-Path $root 'build'
$src = [Drawing.Image]::FromFile((Join-Path $build 'icon.png'))

function Scaled([int]$size) {
  $bmp = New-Object Drawing.Bitmap $size, $size
  $g = [Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = 'HighQualityBicubic'
  $g.SmoothingMode = 'HighQuality'
  $g.DrawImage($src, 0, 0, $size, $size)
  $g.Dispose()
  return $bmp
}

# ICO: заголовок + каталог + PNG-изображения (формат ICO допускает PNG внутри)
$sizes = 16, 24, 32, 48, 64, 128, 256
$pngs = foreach ($s in $sizes) {
  $ms = New-Object IO.MemoryStream
  (Scaled $s).Save($ms, [Drawing.Imaging.ImageFormat]::Png)
  , $ms.ToArray()
}
$out = New-Object IO.MemoryStream
$w = New-Object IO.BinaryWriter $out
$w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $s = $sizes[$i]
  $w.Write([byte]($s % 256)); $w.Write([byte]($s % 256)); $w.Write([byte]0); $w.Write([byte]0)
  $w.Write([uint16]1); $w.Write([uint16]32)
  $w.Write([uint32]$pngs[$i].Length); $w.Write([uint32]$offset)
  $offset += $pngs[$i].Length
}
foreach ($p in $pngs) { $w.Write($p) }
[IO.File]::WriteAllBytes((Join-Path $build 'icon.ico'), $out.ToArray())

# Цвета лаунчера (renderer/styles.css): фон #141814, акцент #b9d38e
$bgTop = [Drawing.Color]::FromArgb(255, 31, 42, 28)
$bgBottom = [Drawing.Color]::FromArgb(255, 16, 20, 16)
$accent = [Drawing.Color]::FromArgb(255, 185, 211, 142)
$muted = [Drawing.Color]::FromArgb(255, 178, 185, 168)

function Canvas([int]$w, [int]$h) {
  $bmp = New-Object Drawing.Bitmap $w, $h, ([Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $g = [Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'HighQuality'; $g.InterpolationMode = 'HighQualityBicubic'; $g.TextRenderingHint = 'AntiAliasGridFit'
  $rect = New-Object Drawing.Rectangle 0, 0, $w, $h
  $g.FillRectangle((New-Object Drawing.Drawing2D.LinearGradientBrush $rect, $bgTop, $bgBottom, 90), $rect)
  return @($bmp, $g)
}

# Боковая панель: свечение акцента, иконка, название, подпись, «кубики» внизу
$bmp, $g = Canvas 164 314
$glow = New-Object Drawing.Drawing2D.GraphicsPath
$glow.AddEllipse(-40, 10, 244, 200)
$pgb = New-Object Drawing.Drawing2D.PathGradientBrush $glow
$pgb.CenterColor = [Drawing.Color]::FromArgb(70, 185, 211, 142)
$pgb.SurroundColors = @([Drawing.Color]::FromArgb(0, 185, 211, 142))
$g.FillPath($pgb, $glow)
$g.DrawImage($src, 34, 40, 96, 96)
$center = New-Object Drawing.StringFormat; $center.Alignment = 'Center'
$g.DrawString('easyLauncher', (New-Object Drawing.Font 'Segoe UI Semibold', 15), (New-Object Drawing.SolidBrush $accent), (New-Object Drawing.RectangleF 0, 150, 164, 30), $center)
$g.DrawString("Лаунчер Minecraft`nсборки · моды · друзья", (New-Object Drawing.Font 'Segoe UI', 8.5), (New-Object Drawing.SolidBrush $muted), (New-Object Drawing.RectangleF 0, 182, 164, 40), $center)
for ($i = 0; $i -lt 6; $i++) {
  $a = 40 + 25 * $i
  $g.FillRectangle((New-Object Drawing.SolidBrush ([Drawing.Color]::FromArgb($a, 185, 211, 142))), 14 + $i * 23, 280, 16, 16)
}
$g.Dispose()
$bmp.Save((Join-Path $build 'installerSidebar.bmp'), [Drawing.Imaging.ImageFormat]::Bmp)

# Шапка: иконка и название
$bmp, $g = Canvas 150 57
$g.DrawImage($src, 8, 9, 39, 39)
$g.DrawString('easyLauncher', (New-Object Drawing.Font 'Segoe UI Semibold', 10.5), (New-Object Drawing.SolidBrush $accent), 52, 12)
$g.DrawString('Minecraft', (New-Object Drawing.Font 'Segoe UI', 8), (New-Object Drawing.SolidBrush $muted), 53, 31)
$g.Dispose()
$bmp.Save((Join-Path $build 'installerHeader.bmp'), [Drawing.Imaging.ImageFormat]::Bmp)
$src.Dispose()
'Готово: build/icon.ico, build/installerSidebar.bmp, build/installerHeader.bmp'
