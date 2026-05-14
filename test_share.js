const dotenv = require('dotenv');
dotenv.config();

const token = process.env.FRAMEIO_TOKEN;

async function test() {
    console.log("Fetching accounts...");
    const accRes = await fetch('https://api.frame.io/v4/accounts', {
        headers: { 'Authorization': `Bearer ${token}` }
    });
    const accounts = await accRes.json();
    const accountId = accounts.data[0].id;
    console.log(`Account ID: ${accountId}`);

    console.log("Fetching projects...");
    const projRes = await fetch(`https://api.frame.io/v4/accounts/${accountId}/workspaces`, {
        headers: { 'Authorization': `Bearer ${token}` }
    });
    const workspaces = await projRes.json();
    
    let projectId = null;
    for (const ws of workspaces.data) {
        const pRes = await fetch(`https://api.frame.io/v4/accounts/${accountId}/workspaces/${ws.id}/projects`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const projects = await pRes.json();
        const p = projects.data.find(p => p.name === "321 TO THE MOON");
        if (p) {
            projectId = p.id;
            break;
        }
    }

    if (!projectId) {
        console.log("Project NOT found.");
        return;
    }
    console.log(`Project ID: ${projectId}`);

    console.log("Creating test share...");
    const shareUrl = `https://api.frame.io/v4/accounts/${accountId}/projects/${projectId}/shares`;
    console.log(`URL: ${shareUrl}`);
    
    const pInfoRes = await fetch(`https://api.frame.io/v4/accounts/${accountId}/projects/${projectId}`, {
        headers: { 'Authorization': `Bearer ${token}` }
    });
    const pInfo = await pInfoRes.json();
    const assetId = pInfo.data.root_folder_id;

    const payload = {
        data: {
            access: 'public',
            name: 'Test Share Iori',
            asset_ids: [assetId],
            downloading_enabled: true
        }
    };

    const sRes = await fetch(shareUrl, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
    });

    console.log(`Status: ${sRes.status}`);
    const result = await sRes.text();
    console.log(`Response: ${result}`);
}

test();
