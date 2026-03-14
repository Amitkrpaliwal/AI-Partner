import axios from 'axios';

const BASE_URL = 'http://localhost:3000/api/mcp';

async function runTests() {
    console.log('Starting MCP Integration Tests...');

    try {
        // 1. List Servers
        console.log('\n--- List Servers ---');
        const serversRes = await axios.get(`${BASE_URL}/servers`);
        const servers = serversRes.data.servers;
        console.log('Servers Response:', JSON.stringify(servers, null, 2));

        // Check if 'filesystem' server is present (it should be allowed even if connecting takes a moment)
        const fsServer = servers.find((s: any) => s.name === 'filesystem');
        console.log('Filesystem Server Found:', fsServer ? 'PASS' : 'WARN (Might need config)');

        // 2. List Tools
        console.log('\n--- List Tools ---');
        try {
            const toolsRes = await axios.get(`${BASE_URL}/tools`);
            console.log('Tools count:', toolsRes.data.tools.length);
            if (toolsRes.data.tools.length > 0) {
                console.log('Example Tool:', toolsRes.data.tools[0].tool.name);
            }
            console.log('List Tools: PASS');
        } catch (e: any) {
            console.log('List Tools: FAIL (Server might not be ready or empty)', e.message);
        }

    } catch (error: any) {
        console.error('Test Failed:', error.response ? error.response.data : error.message);
    }
}

runTests();
