
# Production Verification Script (PowerShell)
$ErrorActionPreference = "Stop"
$BaseUrl = "http://localhost:3000"

Write-Host "🧪 Local AI Co-Worker - Production Verification Suite"
Write-Host "======================================================"

# Test 1: Health Check
Write-Host "`n📋 Test 1: Health Check"
try {
    $health = Invoke-RestMethod -Uri "$BaseUrl/api/health" -Method Get
    if ($health.status -eq "ok") {
        Write-Host "✅ PASS: Server health check verified"
    } else {
        Write-Host "❌ FAIL: Server health check status is $($health.status)"
    }
} catch {
    Write-Host "❌ FAIL: Server health check unavailable: $_"
}

# Test 2: Model Management
Write-Host "`n📋 Test 2: Model Management"
try {
    $models = Invoke-RestMethod -Uri "$BaseUrl/api/models" -Method Get
    if ($models.models.Count -gt 0) {
        Write-Host "✅ PASS: Models available ($($models.models.Count) found)"
        if ($models.active.provider) {
            Write-Host "✅ PASS: Active model verified"
        }
    } else {
        Write-Host "❌ FAIL: No models available"
    }
} catch {
    Write-Host "❌ FAIL: Model API unavailable: $_"
}

# Test 3: Core Memory API
Write-Host "`n📋 Test 3: Core Memory API"
try {
    $memory = Invoke-RestMethod -Uri "$BaseUrl/api/memory/core" -Method Get
    Write-Host "✅ PASS: Core memory API accessible"

    # Update
    $payload = @{
        category = "test_category"
        key = "test_key"
        value = @{ test = $true }
    } | ConvertTo-Json
    
    $update = Invoke-RestMethod -Uri "$BaseUrl/api/memory/core" -Method Post -Body $payload -ContentType "application/json"
    
    if ($update.success) {
        Write-Host "✅ PASS: Core memory update works"
    } else {
        Write-Host "❌ FAIL: Core memory update failed"
    }
    
} catch {
    Write-Host "❌ FAIL: Memory API failed: $_"
}

# Test 4: Conversation Listing
Write-Host "`n📋 Test 4: Conversation Listing"
try {
    $convs = Invoke-RestMethod -Uri "$BaseUrl/api/conversations" -Method Get
    Write-Host "✅ PASS: Conversations API accessible ($($convs.conversations.Count) found)"
} catch {
    Write-Host "❌ FAIL: Conversation API failed: $_"
}

Write-Host "`nDone."
