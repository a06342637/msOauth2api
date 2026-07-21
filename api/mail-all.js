const Imap = require('node-imap');
const { simpleParser } = require('mailparser');

const ALLOWED_MAILBOXES = new Set(['INBOX', 'Junk']);
const MAX_LENGTHS = { refresh_token: 20000, client_id: 200, email: 320, mailbox: 20 };

function getParam(source, name) {
    const value = source && source[name];
    return Array.isArray(value) ? value[0] : value;
}

async function requestAccessToken(refreshToken, clientId, scope) {
    const body = { client_id: clientId, grant_type: 'refresh_token', refresh_token: refreshToken };
    if (scope) body.scope = scope;
    const response = await fetch('https://login.microsoftonline.com/consumers/oauth2/v2.0/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(body).toString()
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Token request failed (${response.status}): ${text.slice(0, 500)}`);
    try { return JSON.parse(text); } catch (error) { throw new Error(`Invalid token response: ${error.message}`); }
}

async function graphAuth(refreshToken, clientId) {
    const data = await requestAccessToken(refreshToken, clientId, 'https://graph.microsoft.com/.default');
    const scopes = String(data.scope || '').split(/\s+/);
    const canReadMail = scopes.some(scope => scope === 'https://graph.microsoft.com/Mail.Read' || scope === 'https://graph.microsoft.com/Mail.ReadWrite');
    return { accessToken: data.access_token, canReadMail };
}

async function getGraphEmails(accessToken, mailbox) {
    if (!accessToken) throw new Error('Microsoft did not return an access token');
    const folder = mailbox === 'Junk' ? 'junkemail' : 'inbox';
    const query = new URLSearchParams({ '$top': '100', '$orderby': 'receivedDateTime desc' });
    const response = await fetch(`https://graph.microsoft.com/v1.0/me/mailFolders/${folder}/messages?${query}`, {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' }
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Graph request failed (${response.status}): ${text.slice(0, 500)}`);
    let data;
    try { data = JSON.parse(text); } catch (error) { throw new Error(`Invalid Graph response: ${error.message}`); }
    return (Array.isArray(data.value) ? data.value : []).map(item => ({
        send: item.from?.emailAddress?.address || '',
        to: (item.toRecipients || []).map(r => r.emailAddress?.address).filter(Boolean).join(', '),
        subject: item.subject || '', text: item.bodyPreview || '', html: item.body?.content || '',
        date: item.receivedDateTime || item.createdDateTime || ''
    }));
}

function getImapEmails({ accessToken, email, mailbox }) {
    return new Promise((resolve, reject) => {
        const xoauth2 = Buffer.from(`user=${email}\x01auth=Bearer ${accessToken}\x01\x01`).toString('base64');
        const imap = new Imap({ user: email, xoauth2, host: 'outlook.office365.com', port: 993, tls: true });
        let settled = false;
        const finish = (error, value) => {
            if (settled) return;
            settled = true;
            try { imap.end(); } catch (_) {}
            error ? reject(error) : resolve(value);
        };
        imap.once('error', error => finish(error));
        imap.once('ready', () => {
            imap.openBox(mailbox, true, (openError) => {
                if (openError) return finish(openError);
                imap.search(['ALL'], (searchError, ids) => {
                    if (searchError) return finish(searchError);
                    if (!ids || ids.length === 0) return finish(null, []);
                    const parsed = [];
                    const fetcher = imap.fetch(ids, { bodies: '' });
                    fetcher.on('message', msg => {
                        msg.on('body', stream => {
                            parsed.push(simpleParser(stream).then(mail => ({
                                send: mail.from?.text || '', to: mail.to?.text || email,
                                subject: mail.subject || '', text: mail.text || '', html: mail.html || '', date: mail.date || ''
                            })));
                        });
                    });
                    fetcher.once('error', error => finish(error));
                    fetcher.once('end', async () => {
                        try {
                            const emails = await Promise.all(parsed);
                            emails.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
                            finish(null, emails);
                        } catch (error) { finish(error); }
                    });
                });
            });
        });
        imap.connect();
    });
}

module.exports = async (req, res) => {
    if (!['GET', 'POST'].includes(req.method)) {
        res.setHeader('Allow', 'GET, POST');
        return res.status(405).json({ error: 'Method not allowed' });
    }
    const source = req.method === 'GET' ? req.query : req.body;
    const params = {};
    for (const name of Object.keys(MAX_LENGTHS)) params[name] = String(getParam(source, name) || '').trim();
    const missing = Object.keys(MAX_LENGTHS).filter(name => !params[name]);
    if (missing.length) return res.status(400).json({ error: `Missing required parameters: ${missing.join(', ')}` });
    const tooLong = Object.keys(MAX_LENGTHS).find(name => params[name].length > MAX_LENGTHS[name]);
    if (tooLong) return res.status(400).json({ error: `Parameter too long: ${tooLong}` });
    if (!ALLOWED_MAILBOXES.has(params.mailbox)) return res.status(400).json({ error: 'Invalid mailbox. Allowed: INBOX, Junk' });

    try {
        const graph = await graphAuth(params.refresh_token, params.client_id);
        if (graph.canReadMail) return res.status(200).json(await getGraphEmails(graph.accessToken, params.mailbox));
        const token = await requestAccessToken(params.refresh_token, params.client_id);
        const emails = await getImapEmails({ accessToken: token.access_token, email: params.email, mailbox: params.mailbox });
        return res.status(200).json(emails);
    } catch (error) {
        console.error('Mail API error:', error);
        return res.status(500).json({ error: error.message || 'Failed to load mail' });
    }
};
