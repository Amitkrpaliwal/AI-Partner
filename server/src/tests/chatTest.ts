import axios from 'axios';

const BASE_URL = 'http://localhost:3000/api/chat';

async function runTests() {
    console.log('Starting Chat API Tests...');

    try {
        // 1. Send simple message
        const message = "Hello, who are you?";
        console.log(`\n--- Sending Message: "${message}" ---`);

        // Set a timeout because LLM generation might take a few seconds
        const res = await axios.post(BASE_URL, {
            message,
            userId: 'test_user'
        }, { timeout: 30000 });

        console.log('Response Status:', res.status);
        console.log('Agent Response:', res.data.response);

        if (res.data.response && res.data.contextUsed) {
            console.log('Chat API: PASS');
        } else {
            console.log('Chat API: FAIL (Missing response structure)');
        }

    } catch (error: any) {
        console.error('Test Failed:', error.message);
        if (error.response) {
            console.error('Server Error Data:', error.response.data);
        }
    }
}

runTests();
