# Does asking for fewer entries per call keep helping?
#
# The contact sheet asks for 99 in one call or 33 in three. A raw page asks for
# 14. Glyph size is identical between them -- the sheet is a 1:1 crop montage of
# these pages -- so this isolates entry count from resolution.
#
# Waits for any run already in flight, so the latency numbers are not measured
# against someone else's traffic.

Set-Location "C:\Users\Krisko\Desktop\snap-automation\vlm_eval"

while (Get-CimInstance Win32_Process -Filter "Name like 'python%'" -ErrorAction SilentlyContinue) {
  Start-Sleep -Seconds 10
}
Write-Output "prior run finished; starting page mode`n"

# The control is gemini-3.6-flash: already 99/99, so it has nothing to gain and
# shows whether page mode costs anything. The rest are the models that improved
# when the sheet was split, which is the trend being extrapolated.
python run_pages.py --models gemini-3.6-flash gemini-2.5-flash-lite gpt-4.1-mini --workers 3

Write-Output "`n=== the two that were furthest behind ==="
python run_pages.py --models gpt-5.1 gpt-5.2 --workers 2

Write-Output "`n=== scoring ==="
python score_pages.py
