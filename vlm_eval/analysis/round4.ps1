# gpt-5.1 hit 99/99 at 9 entries per call. Two things follow, and both need
# testing before that number means anything:
#
#   1. Is it repeatable? gpt-4.1-mini's single-call score wandered 96/96/96/94,
#      so one 99 proves nothing on its own.
#   2. Do the CHEAP models do the same thing? If gpt-4.1-mini or flash-lite also
#      reach 99/99 at this band size, the accuracy winner stops being a Gemini
#      model and starts being a prompt setting.
#
# Waits for anything already running so latency is measured clean.

Set-Location "C:\Users\Krisko\Desktop\snap-automation\vlm_eval"
while (Get-CimInstance Win32_Process -Filter "Name like 'python%'" -ErrorAction SilentlyContinue) {
  Start-Sleep -Seconds 10
}
Write-Output "starting round 4`n"

Write-Output "=== is gpt-5.1 @ 9-per-call repeatable? ==="
foreach ($r in @("rep2", "rep3")) {
  python run_sheet.py --models gpt-5.1 --rows-per-call 3 --workers 1 --tag $r
}

Write-Output "`n=== do the cheap models also reach 99 at 9-per-call? ==="
python run_sheet.py --models gpt-4.1-mini gemini-2.5-flash-lite gpt-5.4-mini gemini-2.5-flash --rows-per-call 3 --workers 4

Write-Output "`n=== scoring ==="
python score_sheet.py
