const settings = require('../settings'); const fs = require('fs'); const path = require('path'); const { isButtonModeOn } = require('../lib/buttonHelper'); const getFakeVcard = require('../lib/fakeVcard'); let sendButtons; try { sendButtons = require('kango-wa').sendButtons; } catch (_) { sendButtons = null; }

function formatTime(seconds) { const days = Math.floor(seconds / (24 * 60 * 60)); seconds = seconds % (24 * 60 * 60); const hours = Math.floor(seconds / (60 * 60)); seconds = seconds % (60 * 60); const minutes = Math.floor(seconds / 60); seconds = Math.floor(seconds % 60);

let time = '';
if (days > 0) time += `${days}d `;
if (hours > 0) time += `${hours}h `;
if (minutes > 0) time += `${minutes}m `;
if (seconds > 0 || time === '') time += `${seconds}s`;

return time.trim();

}

const CATEGORIES = { ai: { emoji: '🤖', title: 'AI', commands: ['.gpt', '.gemini', '.deepseek', '.aiart', '.suno', '.imagine', '.veo3'], }, download: { emoji: '📥', title: 'Download', commands: ['.play', '.song', '.video', '.instagram', '.facebook', '.tiktok', '.snapchat', '.twitter', '.pinterest', '.xnxx'], }, fun: { emoji: '🎯', title: 'Fun', commands: ['.compliment', '.insult', '.flirt', '.goodnight', '.character', '.crush', '.simp', '.stupid', '.ship', '.wasted', '.8ball'], }, games: { emoji: '🎮', title: 'Games', commands: ['.quiz', '.endquiz', '.tictactoe', '.hangman', '.trivia', '.answer', '.truth', '.dare'], }, group: { emoji: '👥', title: 'Group', commands: ['.ban', '.unban', '.promote', '.demote', '.kick', '.mute', '.unmute', '.open', '.close', '.warn', '.warnings', '.antilink', '.antibadword', '.tagall', '.tag', '.clear', '.delete', '.resetlink', '.groupinfo', '.admins', '.welcome', '.setwelcome', '.goodbye', '.setgoodbye', '.poll', '.vcf'], }, general: { emoji: '🌐', title: 'General', commands: ['.menu', '.ping', '.alive', '.tts', '.owner', '.joke', '.quote', '.fact', '.weather', '.news', '.lyrics', '.vv', '.vv2', '.ss', '.jid'], }, owner: { emoji: '🔒', title: 'Owner', commands: ['.mode', '.buttonmode', '.chatbot', '.autoreactstatus', '.autostatusreply', '.statusmsg', '.autoviewstatus', '.poststatus', '.autotype', '.autorecord', '.autorecordtype', '.autoreact', '.autoreply', '.autobio', '.autoread', '.anticall', '.antidelete', '.antiedit', '.setprefix', '.setpp', '.getpp', '.save', '.clearsession', '.cleartmp', '.update'], }, photo: { emoji: '🎨', title: 'Photo', commands: ['.sticker', '.simage', '.blur', '.removebg', '.wanted', '.meme', '.take', '.emojimix', '.tgsticker', '.attp', '.wallpaper'], }, religion: { emoji: '✝️', title: 'Religion', commands: ['.bible', '.quran', '.catholic'], }, tools: { emoji: '💻', title: 'Tools', commands: ['.newsletter', '.trim', '.tomp3', '.translate', '.transcribe', '.tgsearch', '.reportbug', '.ngl', '.script', '.repo'], }, text: { emoji: '🔤', title: 'Text Art', commands: ['.metallic', '.ice', '.snow', '.impressive', '.matrix', '.light', '.neon', '.devil', '.purple', '.thunder', '.leaves', '.1917', '.arena', '.hacker', '.sand', '.blackpink', '.glitch', '.fire'], }, };

function getHeader() { const currentTime = new Date().toLocaleString('en-US', { timeZone: settings.timezone, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, }); const currentDate = new Date().toLocaleString('en-US', { timeZone: settings.timezone, day: '2-digit', month: '2-digit', year: 'numeric', }); const uptimeFormatted = formatTime(process.uptime()); const botMode = settings.commandMode === 'public' ? 'public' : 'private';

return `*『 👑 𝚀𝚄𝙴𝙴𝙽 𝚁𝙸𝙰𝙼 』*\n*│ 👤 ᴏᴡɴᴇʀ     : ${settings.botOwner}*\n*│ 🌍 ᴍᴏᴅᴇ      : [ ${botMode} ]*\n*│ ⏰ ᴛɪᴍᴇ      : ${currentTime}*\n*│ 📅 ᴅᴀᴛᴇ      : ${currentDate}*\n*│ 🛠️ ᴘʀᴇғɪx    : [ . ]*\n*│ 🔄 ᴜᴘᴛɪᴍᴇ    : ${uptimeFormatted}*\n*│ 🌐 ᴛɪᴍᴇᴢᴏɴᴇ : ${settings.timezone}*\n*│ 🚀 ᴠᴇʀsɪᴏɴ   : ${settings.version}*\n*╰─────────⟢*`;

}

function buildCategoryText(key) { const cat = CATEGORIES[key]; if (!cat) return null;

let text = `*『 ${cat.emoji} ${cat.title} Menu 』*\n`;
for (const cmd of cat.commands) {
    text += `*│ ⬡ ${cmd}*\n`;
}
text += `*╰─────────⟢*`;
return text;

}

function buildFullMenu() { let text = getHeader() + '\n'; for (const key of Object.keys(CATEGORIES)) { text += '\n' + buildCategoryText(key) + '\n'; } text += '\n> © ᴘᴏᴡᴇʀᴇᴅ ʙʏ 𝚀𝚄𝙴𝙴𝙽 𝚁𝙸𝙰𝙼'; return text; }

async function sendMenuAudio(sock, chatId) { const audioPath1 = path.join(__dirname, '../media/menu.mp3'); const audioPath2 = path.join(__dirname, '../media/menu2.mp3'); const tracks = [audioPath1, audioPath2]; const chosenTrack = tracks[Math.floor(Math.random() * tracks.length)];

if (fs.existsSync(chosenTrack)) {
    const audioBuffer = fs.readFileSync(chosenTrack);
    await sock.sendMessage(chatId, {
        audio: audioBuffer,
        mimetype: 'audio/mpeg',
        fileName: 'menu.mp3',
        ptt: false,
    }, { quoted: getFakeVcard() });
}

}

async function sendWithImage(sock, chatId, text) { const imagePath = path.join(__dirname, '../media/riam.jpg'); if (fs.existsSync(imagePath)) { const imageBuffer = fs.readFileSync(imagePath); await sock.sendMessage(chatId, { image: imageBuffer, caption: text, }, { quoted: getFakeVcard() }); } else { await sock.sendMessage(chatId, { text }, { quoted: getFakeVcard() }); } }

function loadMenuImage() { const imagePath = path.join(__dirname, '../media/riam.jpg'); if (fs.existsSync(imagePath)) return fs.readFileSync(imagePath); return null; }

async function helpCommand(sock, chatId, message, _, subCategory) { const menuImage = loadMenuImage();

if (subCategory && CATEGORIES[subCategory]) {
    const catText = buildCategoryText(subCategory) + '\n\n> *© ᴘᴏᴡᴇʀᴇᴅ ʙʏ 𝚀𝚄𝙴𝙴𝙽 𝚁𝙸𝙰𝙼*';

    if (isButtonModeOn() && sendButtons) {
        try {
            const opts = {
                text: catText,
                footer: '© Queen Riam',
                buttons: [
                    { id: '.help', text: '🔙 Back to Menu' },
                ],
                quoted: getFakeVcard(),
            };
            if (menuImage) opts.image = menuImage;
            await sendButtons(sock, chatId, opts);
        } catch (_) {
            await sendWithImage(sock, chatId, catText);
        }
    } else {
        await sendWithImage(sock, chatId, catText);
    }
    return;
}

if (isButtonModeOn() && sendButtons) {
    try {
        const menuText = getHeader() + '\n\n_Tap a category below to view its commands_';

        const buttons = Object.entries(CATEGORIES).map(([key, cat]) => ({
            id: `.help ${key}`,
            text: `${cat.emoji} ${cat.title}`,
        }));

        const opts = {
            text: menuText,
            footer: '© Queen Riam',
            buttons,
            quoted: getFakeVcard(),
        };
        if (menuImage) opts.image = menuImage;
        await sendButtons(sock, chatId, opts);

        await sendMenuAudio(sock, chatId);
        return;
    } catch (err) {
        console.error('[HELP] Button menu failed, falling back to full menu:', err.message);
    }
}

const fullMenu = buildFullMenu();

try {
    await sendWithImage(sock, chatId, fullMenu);
    await sendMenuAudio(sock, chatId);
} catch (error) {
    console.error('Error in help command:', error);
    await sock.sendMessage(chatId, { text: fullMenu }, { quoted: getFakeVcard() });
}

}

module.exports = helpCommand;
