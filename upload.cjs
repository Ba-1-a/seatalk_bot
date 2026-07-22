const fs = require('fs');
const path = require('path');
const TOKEN = 'adf66d648188c72c3173b698948a128f4b8f7a13b32014bff9ee914b43a6007a';
const REPO = 'ba-1-a/B-Cube_Tech';

async function uploadFile(filePath, repoPath) {
    if (!fs.existsSync(filePath)) {
        console.error(`File not found: ${filePath}`);
        return;
    }
    const content = fs.readFileSync(filePath);
    const url = `https://huggingface.co/api/repos/space/${REPO}/raw/main/${repoPath}`;
    
    console.log(`Uploading ${repoPath}...`);
    const res = await fetch(url, {
        method: 'PUT',
        headers: {
            'Authorization': `Bearer ${TOKEN}`,
            'Content-Type': 'application/octet-stream'
        },
        body: content
    });
    
    const text = await res.text();
    console.log(`[${repoPath}] Status: ${res.status}`, text);
}

async function main() {
    await uploadFile(path.join(__dirname, 'hf-spaces', 'index.js'), 'index.js');
    await uploadFile(path.join(__dirname, 'hf-spaces', 'api', 'index.js'), 'api/index.js');
    console.log('Done!');
}

main();
