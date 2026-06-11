import { logger } from '../utils/logger.js';
import { EmbedBuilder } from 'discord.js';

const TWITCH_CHANNELS = ['larox_vlr', 'kcso6', 'ffierflex'];
const CHECK_INTERVAL = 60000; // Vérification toutes les 60 secondes

const liveStatus = new Map();

async function getTwitchToken() {
    const response = await fetch(
        `https://id.twitch.tv/oauth2/token?client_id=${process.env.TWITCH_CLIENT_ID}&client_secret=${process.env.TWITCH_CLIENT_SECRET}&grant_type=client_credentials`,
        { method: 'POST' }
    );
    const data = await response.json();
    return data.access_token;
}

async function getStreamData(token, usernames) {
    const query = usernames.map(u => `user_login=${u}`).join('&');
    const response = await fetch(
        `https://api.twitch.tv/helix/streams?${query}`,
        {
            headers: {
                'Client-ID': process.env.TWITCH_CLIENT_ID,
                'Authorization': `Bearer ${token}`,
            }
        }
    );
    const data = await response.json();
    return data.data || [];
}

async function getUserData(token, usernames) {
    const query = usernames.map(u => `login=${u}`).join('&');
    const response = await fetch(
        `https://api.twitch.tv/helix/users?${query}`,
        {
            headers: {
                'Client-ID': process.env.TWITCH_CLIENT_ID,
                'Authorization': `Bearer ${token}`,
            }
        }
    );
    const data = await response.json();
    return data.data || [];
}

export async function startTwitchMonitor(client) {
    logger.info('[Twitch] Démarrage du monitoring Twitch...');

    // Initialiser le statut de tous les streamers à offline
    for (const channel of TWITCH_CHANNELS) {
        liveStatus.set(channel, false);
    }

    setInterval(async () => {
        try {
            const token = await getTwitchToken();
            const streams = await getStreamData(token, TWITCH_CHANNELS);
            const users = await getUserData(token, TWITCH_CHANNELS);

            const notifChannel = await client.channels.fetch(process.env.TWITCH_NOTIFICATION_CHANNEL);
            if (!notifChannel) return;

            for (const channel of TWITCH_CHANNELS) {
                const stream = streams.find(s => s.user_login.toLowerCase() === channel.toLowerCase());
                const wasLive = liveStatus.get(channel);

                if (stream && !wasLive) {
                    // Le stream vient de commencer
                    liveStatus.set(channel, true);

                    const user = users.find(u => u.login.toLowerCase() === channel.toLowerCase());
                    const thumbnailUrl = stream.thumbnail_url
                        .replace('{width}', '1280')
                        .replace('{height}', '720');

                    const embed = new EmbedBuilder()
                        .setColor('#9146FF')
                        .setTitle(`🔴 ${stream.user_name} est en live. Rejoignez-le !`)
                        .setURL(`https://www.twitch.tv/${channel}`)
                        .setDescription(`**${stream.title}**`)
                        .addFields(
                            { name: '🎮 Jeu', value: stream.game_name || 'Non renseigné', inline: true },
                            // { name: '👥 Viewers', value: `${stream.viewer_count}`, inline: true },
                        )
                        .setImage(thumbnailUrl)
                        .setThumbnail(user?.profile_image_url || null)
                        .setFooter({ text: 'RCTE • Twitch' })
                        .setTimestamp();

                    await notifChannel.send({
                        content: `@everyone`,
                        embeds: [embed],
                    });

                    logger.info(`[Twitch] Notification envoyée pour ${channel}`);

                } else if (!stream && wasLive) {
                    // Le stream vient de se terminer
                    liveStatus.set(channel, false);
                    logger.info(`[Twitch] ${channel} a terminé son stream`);
                }
            }
        } catch (error) {
            logger.error('[Twitch] Erreur lors du monitoring:', error);
        }
    }, CHECK_INTERVAL);
}
