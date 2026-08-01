# Second round: does the leaderboard hold up, and does splitting the sheet help?
#
# Three things the first round could not answer:
#   1. repeatability -- 99/99 from one call could be luck, so the finalists run
#      three more times each
#   2. band mode -- 3 calls of 33 entries instead of 1 call of 99, which costs
#      more image tokens and may or may not buy accuracy
#   3. real latency -- round one ran 17 models over 6 workers, so every number
#      in it includes contention. The finalists re-run one at a time.
#
# Billing is sampled before and after, because the gateway publishes no price
# for gemini-3.6-flash and measuring the spend is the only way to get one.

Set-Location "C:\Users\Krisko\Desktop\snap-automation\vlm_eval"
$key = (Get-Content .apimart_key -Raw).Trim()
function Usage {
  (Invoke-RestMethod -Uri "https://api.apimart.ai/v1/dashboard/billing/usage" `
    -Headers @{Authorization = "Bearer $key"} -TimeoutSec 30).total_usage
}

$before = Usage
Write-Output "billing before: $before"

$finalists = @("gemini-3.6-flash", "gemini-2.5-flash-lite", "gemini-2.5-flash",
               "gpt-4.1-mini", "gemini-3-pro-preview")

foreach ($rep in @("rep2", "rep3")) {
  Write-Output "`n=== repeat $rep ==="
  python run_sheet.py --models $finalists --workers 5 --tag $rep
}

Write-Output "`n=== band mode: 3 calls of 33 entries ==="
python run_sheet.py --models $finalists --rows-per-call 11 --workers 5

Write-Output "`n=== solo latency (one model at a time, no contention) ==="
foreach ($m in $finalists) {
  python run_sheet.py --models $m --workers 1 --tag solo
}

$after = Usage
Write-Output "`nbilling after: $after   delta: $($after - $before)"
