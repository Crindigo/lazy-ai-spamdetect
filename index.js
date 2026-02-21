import { ImapFlow } from 'imapflow';
import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import 'dotenv/config';
import fs from 'fs';

// run with node index.js configfile.json
// lazy config format, see https://imapflow.com/docs/guides/configuration
/*{
    host: 'xxx',
    port: 143,
    secure: false,
    logger: false,
    tls: {
        rejectUnauthorized: false,
    },
    auth: {
        user: 'xxx',
        pass: 'xxx',
    }
}*/

const options = JSON.parse(fs.readFileSync(process.argv[2]));
const client = new ImapFlow(options);

const inputCost = 0.5 / 1000000;
const outputCost = 3 / 1000000;

await client.connect();

const ai = new GoogleGenAI({apiKey: process.env.GEMINI_KEY});

function quit() {
    client.logout();
    process.exit(0);
}

let lock = await client.getMailboxLock('INBOX');
try {
    if (client.mailbox.exists === 0) {
        console.log("No messages in inbox");
        quit();
    }

    let uids = await client.search({seen: false}, {uid: true});
    //console.log("UNSEEN UIDS", uids);
    if ( !uids.length ) {
        console.log("No unread messages");
        quit();
    }

    let messages = await client.fetchAll(uids, {
        envelope: true,
        flags: true,
    }, {uid: true});

    let emailList = '';
    let number = 1; // use smaller numbers instead of full UIDs to save on tokens
    let numberToUid = {};
    for (let message of messages) {
        const fromEmail = message.envelope.from[0].address;
        const fromName = message.envelope.from[0].name;
        const subject = message.envelope.subject || "(No Subject)";
        numberToUid[number] = message.uid;
        emailList += `${number}: ${subject} | From: ${fromName} <${fromEmail}>\n`;
        number++;
    }
    const aiInput = `A list of email IDs, subjects, from name, and from email are given below. Score each email on a ranking of 0-100 for likelyhood of spam, with 100 meaning you are 100% sure it is spam. Only output a list of results like "ID: Score".\n\n${emailList}`;
    console.log(aiInput);

    const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: aiInput,
        config: {
            thinkingConfig: {
                thinkingLevel: ThinkingLevel.MINIMAL,
            },
        },
    });

    console.log(response.text);
    const totalCost = response.usageMetadata.promptTokenCount * inputCost + response.usageMetadata.candidatesTokenCount * outputCost;
    console.log(response.usageMetadata);
    console.log("Total Cost:", totalCost);

    let spamUids = [];
    response.text.split(/\r?\n/).forEach(line => {
        let [number, score] = line.split(/:/);
        number = parseInt(number.trim());
        score = parseInt(score.trim());
        console.log(number, numberToUid[number], score);
        if ( score >= 90 ) {
            spamUids.push(numberToUid[number]);
        }
    });

    console.log("SPAM UIDS:", spamUids);
    if ( spamUids.length > 0 ) {
        console.log("Moving", spamUids.length, "messages to Junk");
        await client.messageMove(spamUids, 'Junk', {uid: true});
        console.log("Done");
    }
} finally {
    lock.release();
}

quit();
