import axios from 'axios';

const BASE_URL = 'http://localhost:3000/api/tasks';

async function runTests() {
    console.log('Starting Task Scheduler Tests...');

    try {
        // 1. Create Task
        const taskName = `Test Task ${Date.now()}`;
        console.log(`\n--- Create Task: ${taskName} ---`);
        const createRes = await axios.post(BASE_URL, {
            name: taskName,
            schedule: '* * * * *',
            action: 'log',
            parameters: { message: 'Test execution' }
        });
        console.log('Create Task:', createRes.data.success ? 'PASS' : 'FAIL', 'ID:', createRes.data.id);
        const taskId = createRes.data.id;

        // 2. List Tasks
        console.log('\n--- List Tasks ---');
        const listRes = await axios.get(BASE_URL);
        const tasks = listRes.data.tasks;
        const found = tasks.find((t: any) => t.id === taskId);
        console.log('List Tasks:', found ? 'PASS' : 'FAIL');

        // 3. Delete Task
        if (found) {
            console.log('\n--- Delete Task ---');
            const deleteRes = await axios.delete(`${BASE_URL}/${taskId}`);
            console.log('Delete Task:', deleteRes.data.success ? 'PASS' : 'FAIL');

            const listRes2 = await axios.get(BASE_URL);
            const found2 = listRes2.data.tasks.find((t: any) => t.id === taskId);
            console.log('Verify Deletion:', !found2 ? 'PASS' : 'FAIL');
        }

    } catch (error: any) {
        console.error('Test Failed:', error.response ? error.response.data : error.message);
    }
}

runTests();
