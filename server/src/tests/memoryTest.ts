import axios from 'axios';

const BASE_URL = 'http://localhost:3000/api/memory';

async function runTests() {
    console.log('Starting Memory System Tests...');

    try {
        // 1. Test Persona
        console.log('\n--- Testing Persona ---');
        const updatePersonaRes = await axios.post(`${BASE_URL}/persona`, {
            name: 'Test User',
            role: 'Tester',
            preferences: { theme: 'dark' }
        });
        console.log('Update Persona:', updatePersonaRes.data.success ? 'PASS' : 'FAIL');

        const getPersonaRes = await axios.get(`${BASE_URL}/persona`);
        const persona = getPersonaRes.data;
        console.log('Get Persona:', persona.name === 'Test User' && persona.preferences.theme === 'dark' ? 'PASS' : 'FAIL', persona);

        // 2. Test Events
        console.log('\n--- Testing Events ---');
        const storeEventRes = await axios.post(`${BASE_URL}/events`, {
            event_text: 'Ran a memory test',
            event_type: 'learning',
            context: { testId: 123 }
        });
        console.log('Store Event:', storeEventRes.data.success ? 'PASS' : 'FAIL', 'ID:', storeEventRes.data.id);

        const getEventsRes = await axios.get(`${BASE_URL}/events?limit=5`);
        const events = getEventsRes.data.events;
        const foundEvent = events.find((e: any) => e.event_text === 'Ran a memory test');
        console.log('Get Events:', foundEvent ? 'PASS' : 'FAIL');

        // 3. Test Facts
        console.log('\n--- Testing Facts ---');
        const storeFactRes = await axios.post(`${BASE_URL}/facts`, {
            subject: 'User',
            predicate: 'likes',
            object: 'Automated Testing',
            confidence: 0.9
        });
        console.log('Store Fact:', storeFactRes.data.success ? 'PASS' : 'FAIL', 'ID:', storeFactRes.data.id);

        const getFactsRes = await axios.get(`${BASE_URL}/facts?subject=User&predicate=likes`);
        const facts = getFactsRes.data.facts;
        const foundFact = facts.find((f: any) => f.object === 'Automated Testing');
        console.log('Query Facts:', foundFact ? 'PASS' : 'FAIL', foundFact);

    } catch (error: any) {
        console.error('Test Failed:', error.response ? error.response.data : error.message);
    }
}

runTests();
