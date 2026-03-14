import axios from 'axios';

const BASE_URL = 'http://localhost:3000/api/heartbeat';

async function runTests() {
    console.log('Starting Heartbeat System Tests...');

    try {
        // 1. Check Status
        console.log('\n--- Status Check ---');
        const statusRes = await axios.get(`http://localhost:3000/api/health`);
        const heartbeatStatus = statusRes.data.heartbeat;
        console.log('Initial Status:', heartbeatStatus.enabled ? 'PASS' : 'FAIL', heartbeatStatus);

        // 2. Update Config
        console.log('\n--- Config Update ---');
        const configRes = await axios.post(`${BASE_URL}/config`, {
            interval: '15m',
            activeHours: { start: '00:00', end: '23:59' } // Ensure it's active now
        });
        console.log('Update Config:', configRes.data.config.interval === '15m' ? 'PASS' : 'FAIL');

        // 3. Trigger Heartbeat
        console.log('\n--- Manual Trigger ---');
        const triggerRes = await axios.post(`${BASE_URL}/trigger`);
        console.log('Trigger:', triggerRes.data.success ? 'PASS' : 'FAIL', triggerRes.data.message);

        // 4. Verify Status Change (Last Tick)
        const finalStatusRes = await axios.get(`http://localhost:3000/api/health`);
        console.log('Last Tick Updated:', finalStatusRes.data.heartbeat.lastTick ? 'PASS' : 'FAIL');

    } catch (error: any) {
        console.error('Test Failed:', error.response ? error.response.data : error.message);
    }
}

runTests();
