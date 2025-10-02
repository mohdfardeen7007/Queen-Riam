const isAdmin = require('../lib/isAdmin'); // The isAdmin function is no longer used for the permission check.

async function tagAllCommand(sock, chatId, senderId) {
    try {
        // Get group metadata
        const groupMetadata = await sock.groupMetadata(chatId);
        const participants = groupMetadata.participants;

        if (!participants || participants.length === 0) {
            await sock.sendMessage(chatId, { text: 'No participants found in the group.' });
            return;
        }

        const groupName = groupMetadata.subject || "Unnamed Group";
        const totalMembers = participants.length;

        // ✨ Add announcement message here
        const announcement = "🧭ᩨ─ *𝐀𐓣𐓣ⱺυ𐓣𝖼𝖾ꭑ𝖾𐓣𝗍:*\n𝐖α𝗄𝖾 𝐔ρ 𝐄𝗏𝖾𝗋𝗒ⱺ𐓣e\n";

        // Create message
        let message = `━﹝̣ׄ🩰̸̶ּׄ͜﹞ *𝐆𝖼 𝐍αꭑ𝖾:* ${groupName}\n━﹝̣ׄ🌟̸̶ּׄ͜﹞ *𝐓ⱺ𝗍αᥣ 𝐌𝖾ꭑᑲ𝖾𝗋𝗌:* ${totalMembers}\n\n${announcement}\n🔊 *𝐓α𝗀𝗀𝖾ᑯ 𝐌𝖾ꭑᑲ𝖾𝗋𝗌:*\n\n`;

        participants.forEach(participant => {
            message += `@${participant.id.split(━ ✦ ⃞🥮ᩧᩙᩪᩩ̶̷  ͟ ͟ ͟ ͟'@')[0]}\n`;
        });

        // Send message with mentions
        await sock.sendMessage(chatId, {
            text: message,
            mentions: participants.map(p => p.id)
        });

    } catch (error) {
        console.error('Error in tagall command:', error);
        await sock.sendMessage(chatId, { text: 'Failed to tag all members.' });
    }
}

module.exports = tagAllCommand;
