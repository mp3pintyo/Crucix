// Discord Alerter — Multi-tier alerts + slash commands via discord.js
// Mirrors TelegramAlerter architecture: same eval logic, same tier system, same dedup

import { createHash } from 'crypto';
import { getLLMBudget } from '../llm/budgets.mjs';
import { alertObject, normalizeAlertEvaluation } from '../llm/alert-schema.mjs';
import { extractJson, fallbackLine } from '../llm/json-extract.mjs';
import { normalizeIdeas } from '../llm/idea-schema.mjs';

// ─── Alert Tiers (shared with Telegram) ─────────────────────────────────────

const TIER_CONFIG = {
  FLASH:    { color: 0xFF0000, label: 'FLASH',    cooldownMs: 5 * 60 * 1000,  maxPerHour: 6 },
  PRIORITY: { color: 0xFFAA00, label: 'PRIORITY', cooldownMs: 30 * 60 * 1000, maxPerHour: 4 },
  ROUTINE:  { color: 0x3498DB, label: 'ROUTINE',  cooldownMs: 60 * 60 * 1000, maxPerHour: 2 },
};

// Slash command definitions for Discord's API
const SLASH_COMMANDS = [
  { name: 'status',    description: 'System health, last sweep time, source status' },
  { name: 'sweep',     description: 'Trigger a manual sweep cycle' },
  { name: 'brief',     description: 'Compact intelligence summary' },
  { name: 'portfolio', description: 'Portfolio status (if Alpaca connected)' },
  { name: 'alerts',    description: 'Recent alert history' },
  { name: 'mute',      description: 'Mute alerts (default 1h)',
    options: [{ name: 'hours', description: 'Hours to mute (default: 1)', type: 10, required: false }] },
  { name: 'unmute',    description: 'Resume alerts' },
];

export class DiscordAlerter {
  constructor({ botToken, channelId, guildId, webhookUrl, allowedUserIds = [] }) {
    this.botToken = botToken;
    this.channelId = channelId;
    this.guildId = guildId;        // Server ID for slash command registration
    this.allowedUserIds = new Set(allowedUserIds);
    this.webhookUrl = webhookUrl;  // Fallback: webhook-only mode (no bot needed)
    this._client = null;
    this._alertHistory = [];
    this._contentHashes = {};
    this._muteUntil = null;
    this._commandHandlers = {};
    this._ready = false;
    this._ephemeralReplyFlags = undefined;
  }

  get isConfigured() {
    return !!(this.botToken && this.channelId) || !!this.webhookUrl;
  }

  // ─── Bot Lifecycle ──────────────────────────────────────────────────────

  /**
   * Start the Discord bot. Connects to the gateway, registers slash commands,
   * and begins listening for interactions.
   */
  async start() {
    if (!this.isConfigured) return;

    try {
      // Dynamic import — discord.js is optional, only loaded if configured
      const { Client, GatewayIntentBits, MessageFlags, REST, Routes, EmbedBuilder, SlashCommandBuilder } = await import('discord.js');
      this._EmbedBuilder = EmbedBuilder;
      this._ephemeralReplyFlags = MessageFlags.Ephemeral;

      this._client = new Client({
        intents: [GatewayIntentBits.Guilds],
      });

      // Handle slash command interactions
      this._client.on('interactionCreate', async (interaction) => {
        if (!interaction.isChatInputCommand()) return;
        await this._handleCommand(interaction);
      });

      this._client.once('clientReady', async (client) => {
        this._ready = true;
        console.log(`[Discord] Bot online as ${client.user.tag}`);
        await this._registerCommands(REST, Routes, SlashCommandBuilder);
      });

      // Connect
      await this._client.login(this.botToken);

    } catch (err) {
      if (err.code === 'MODULE_NOT_FOUND' || err.message?.includes('Cannot find')) {
        console.warn('[Discord] discord.js not installed. Run: npm install discord.js');
        console.warn('[Discord] Falling back to webhook-only mode (if DISCORD_WEBHOOK_URL is set).');
      } else {
        console.error('[Discord] Failed to start bot:', err.message);
      }
    }
  }

  /**
   * Stop the bot gracefully.
   */
  async stop() {
    if (this._client) {
      this._client.destroy();
      this._client = null;
      this._ready = false;
      console.log('[Discord] Bot disconnected');
    }
  }

  // ─── Slash Command Registration ─────────────────────────────────────────

  async _registerCommands(REST, Routes, SlashCommandBuilder) {
    const rest = new REST({ version: '10' }).setToken(this.botToken);
    const appId = this._client?.application?.id ?? this._client?.user?.id;

    const commands = SLASH_COMMANDS.map(cmd => {
      const builder = new SlashCommandBuilder()
        .setName(cmd.name)
        .setDescription(cmd.description);

      if (cmd.options) {
        for (const opt of cmd.options) {
          if (opt.type === 10) { // NUMBER
            builder.addNumberOption(o =>
              o.setName(opt.name).setDescription(opt.description).setRequired(opt.required ?? false)
            );
          }
        }
      }
      return builder.toJSON();
    });

    try {
      if (!appId) {
        console.warn('[Discord] Skipping slash command registration because the application ID is not available yet.');
        return;
      }

      if (this.guildId) {
        // Guild commands (instant, for development)
        await rest.put(Routes.applicationGuildCommands(appId, this.guildId), { body: commands });
        console.log(`[Discord] Registered ${commands.length} guild slash commands`);
      } else {
        // Global commands (can take up to 1h to propagate)
        await rest.put(Routes.applicationCommands(appId), { body: commands });
        console.log(`[Discord] Registered ${commands.length} global slash commands`);
      }
    } catch (err) {
      console.error('[Discord] Failed to register slash commands:', err.message);
    }
  }

  // ─── Command Handling ───────────────────────────────────────────────────

  /**
   * Register a command handler.
   * @param {string} name - command name (without /)
   * @param {Function} handler - async (args) => responseText
   */
  onCommand(name, handler) {
    this._commandHandlers[name.toLowerCase()] = handler;
  }

  async _handleCommand(interaction) {
    const name = interaction.commandName;
    const inChannel = interaction.channelId === this.channelId && (!this.guildId || interaction.guildId === this.guildId);
    const stateChanging = ['mute', 'unmute', 'sweep'].includes(name);
    const allowedUser = this.allowedUserIds.has(interaction.user?.id);
    const admin = interaction.memberPermissions?.has(32n) || interaction.memberPermissions?.has(8n);
    if (!inChannel || (stateChanging && !(this.allowedUserIds.size ? allowedUser : admin))) {
      await interaction.reply({ content: 'This command is not authorized here.', flags: this._ephemeralReplyFlags ?? 64 });
      return;
    }

    // Built-in commands
    if (name === 'mute') {
      const requestedHours = interaction.options.getNumber('hours') ?? 1;
      const hours = Number.isFinite(requestedHours) ? Math.min(168, Math.max(0.01, requestedHours)) : 1;
      this._muteUntil = Date.now() + hours * 60 * 60 * 1000;
      await interaction.reply({
        embeds: [this._embed('Alerts Muted', `Alerts silenced for ${hours}h — until ${new Date(this._muteUntil).toLocaleTimeString()} UTC.\nUse \`/unmute\` to resume.`, 0x95A5A6)],
        flags: this._ephemeralReplyFlags,
      });
      return;
    }

    if (name === 'unmute') {
      this._muteUntil = null;
      await interaction.reply({
        embeds: [this._embed('Alerts Resumed', 'You will receive the next signal evaluation.', 0x2ECC71)],
        flags: this._ephemeralReplyFlags,
      });
      return;
    }

    if (name === 'alerts') {
      const recent = this._alertHistory.slice(-10);
      if (recent.length === 0) {
        await interaction.reply({ content: 'No recent alerts.', flags: this._ephemeralReplyFlags });
        return;
      }
      const tierEmoji = { FLASH: '🔴', PRIORITY: '🟡', ROUTINE: '🔵' };
      const lines = recent.map(a =>
        `${tierEmoji[a.tier] || '⚪'} **${a.tier}** — ${new Date(a.timestamp).toLocaleTimeString()}`
      );
      await interaction.reply({
        embeds: [this._embed(`Recent Alerts (${recent.length})`, lines.join('\n'), 0x3498DB)],
        flags: this._ephemeralReplyFlags,
      });
      return;
    }

    // Delegate to registered handlers
    const handler = this._commandHandlers[name];
    if (handler) {
      await interaction.deferReply({ flags: this._ephemeralReplyFlags });
      try {
        const args = interaction.options.getString('input') || '';
        const response = await handler(args);
        if (response) {
          // If response is long, send as embed; otherwise plain text
          if (response.length > 200) {
            await interaction.editReply({ embeds: [this._embed('Crucix', response, 0x00E5FF)] });
          } else {
            await interaction.editReply({ content: response });
          }
        } else {
          await interaction.editReply({ content: 'Done.' });
        }
      } catch (err) {
        console.error(`[Discord] Command /${name} error:`, err.message);
        await interaction.editReply({ content: `Command failed: ${err.message}` });
      }
    } else {
      await interaction.reply({ content: `Unknown command: /${name}`, flags: this._ephemeralReplyFlags });
    }
  }

  // ─── Sending Messages ───────────────────────────────────────────────────

  /**
   * Send a message to the configured channel.
   * Works with the bot client or falls back to webhook URL.
   * `options.suppressMentions`: no @everyone, role or user mention in `content` pings anyone.
   */
  async sendMessage(content, embeds = [], options = {}) {
    const suppressMentions = options?.suppressMentions === true;
    if (!this.isConfigured) return false;

    // Try bot client first
    if (this._ready && this._client) {
      try {
        const channel = await this._client.channels.fetch(this.channelId);
        if (channel) {
          await channel.send({ content: content || undefined, embeds, ...(suppressMentions ? { allowedMentions: { parse: [] } } : {}) });
          return true;
        }
      } catch (err) {
        console.error('[Discord] Send via bot failed:', err.message);
      }
    }

    // Fallback: webhook URL
    if (this.webhookUrl) {
      return this._sendWebhook(this.webhookUrl, content, embeds, suppressMentions);
    }

    console.warn('[Discord] Cannot send — bot not ready and no webhook URL configured');
    return false;
  }

  async _sendWebhook(url, content, embeds, suppressMentions = false) {
    try {
      const body = {};
      if (content) body.content = content;
      if (suppressMentions) body.allowed_mentions = { parse: [] };
      if (embeds?.length > 0) {
        body.embeds = embeds.map(e => e.toJSON ? e.toJSON() : e);
      }

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });

      if (!res.ok) {
        const err = await res.text().catch(() => '');
        console.error(`[Discord] Webhook failed (${res.status}): ${err.substring(0, 200)}`);
        return false;
      }
      return true;
    } catch (err) {
      console.error('[Discord] Webhook error:', err.message);
      return false;
    }
  }

  // Backward-compatible alias
  async sendAlert(message) {
    return this.sendMessage(message);
  }

  // ─── Multi-Tier Alert Evaluation ────────────────────────────────────────
  // Identical logic to TelegramAlerter — shared eval pipeline

  async evaluateAndAlert(llmProvider, delta, memory) {
    if (!this.isConfigured) return false;
    if (!delta?.summary?.totalChanges) return false;
    if (this._isMuted()) {
      console.log('[Discord] Alerts muted until', new Date(this._muteUntil).toLocaleTimeString());
      return false;
    }

    const allSignals = [
      ...(delta.signals?.new || []),
      ...(delta.signals?.escalated || []),
    ];

    const newSignals = allSignals.filter(s => {
      const key = this._signalKey(s);
      if (typeof memory.isSignalSuppressed === 'function') {
        if (memory.isSignalSuppressed(key)) return false;
      } else {
        const alerted = memory.getAlertedSignals();
        if (alerted[key]) return false;
      }
      if (this._isSemanticDuplicate(s)) return false;
      return true;
    });

    if (newSignals.length === 0) return false;

    // LLM evaluation with rule-based fallback (reuse from Telegram)
    let evaluation = null;

    if (llmProvider?.isConfigured) {
      try {
        const { TelegramAlerter } = await import('./telegram.mjs');
        const tgInstance = new TelegramAlerter({ botToken: null, chatId: null });
        const systemPrompt = tgInstance._buildEvaluationPrompt();
        const userMessage = tgInstance._buildSignalContext(newSignals, delta);
        const result = await llmProvider.complete(systemPrompt, userMessage, getLLMBudget(llmProvider.config, 'alerts'));
        const { value, reason } = extractJson(result.text, { accept: alertObject });
        evaluation = normalizeAlertEvaluation(value);
        // The rules take over below; say why, as that used to be silent.
        if (!evaluation) console.warn(fallbackLine({ label: '[Discord]', path: 'alert', reason: reason ?? 'all_items_invalid', result, dropped: reason ? 0 : 1, budgetVar: 'LLM_ALERT_MAX_TOKENS' }));
      } catch (err) {
        console.warn('[Discord] LLM evaluation failed, falling back to rules:', err.message);
      }
    }

    if (!evaluation || typeof evaluation.shouldAlert !== 'boolean') {
      evaluation = this._ruleBasedEvaluation(newSignals, delta);
      if (evaluation) evaluation._source = 'rules';
    }

    if (!evaluation?.shouldAlert) {
      console.log('[Discord] No alert —', evaluation?.reason || 'no qualifying signals');
      return false;
    }

    const tier = TIER_CONFIG[evaluation.tier] ? evaluation.tier : 'ROUTINE';
    if (!this._checkRateLimit(tier)) {
      console.log(`[Discord] Rate limited for tier ${tier}`);
      return false;
    }

    // Build Discord embed
    const embed = this._buildAlertEmbed(evaluation, delta, tier);
    const sent = await this.sendMessage(null, [embed]);

    if (sent) {
      for (const s of newSignals) {
        const key = this._signalKey(s);
        memory.markAsAlerted(key, new Date().toISOString());
        this._recordContentHash(s);
      }
      this._recordAlert(tier);
      console.log(`[Discord] ${tier} alert sent (${evaluation._source || 'llm'}): ${evaluation.headline}`);
    }

    return sent;
  }

  // ─── Discord-Native Rich Embed Formatting ───────────────────────────────

  _buildAlertEmbed(evaluation, delta, tier) {
    const tc = TIER_CONFIG[tier];
    const tierEmoji = { FLASH: '🔴', PRIORITY: '🟡', ROUTINE: '🔵' }[tier] || '⚪';
    const confidenceEmoji = { HIGH: '🟢', MEDIUM: '🟡', LOW: '⚪' }[evaluation.confidence] || '⚪';

    const embed = this._embed(
      `${tierEmoji} CRUCIX ${tc.label}`,
      `**${evaluation.headline}**\n\n${evaluation.reason}`,
      tc.color
    );

    // Add fields
    const fields = [
      { name: 'Direction', value: delta.summary.direction.toUpperCase(), inline: true },
      { name: 'Confidence', value: `${confidenceEmoji} ${evaluation.confidence || 'MEDIUM'}`, inline: true },
    ];

    if (evaluation.crossCorrelation) {
      fields.push({ name: 'Cross-Correlation', value: evaluation.crossCorrelation, inline: true });
    }

    if (evaluation.actionable && evaluation.actionable !== 'Monitor') {
      fields.push({ name: '💡 Action', value: evaluation.actionable, inline: false });
    }

    if (evaluation.signals?.length) {
      fields.push({ name: 'Signals', value: evaluation.signals.join(' · '), inline: false });
    }

    // discord.js EmbedBuilder style
    if (embed.setFields) {
      embed.setFields(fields);
      embed.setFooter({ text: `Crucix Intelligence · ${new Date().toISOString().replace('T', ' ').substring(0, 19)} UTC` });
    } else {
      // Raw embed object for webhook fallback
      embed.fields = fields;
      embed.footer = { text: `Crucix Intelligence · ${new Date().toISOString().replace('T', ' ').substring(0, 19)} UTC` };
    }

    return embed;
  }

  /**
   * Create a simple embed. Returns EmbedBuilder if available, otherwise raw object.
   */
  _embed(title, description, color) {
    if (this._EmbedBuilder) {
      return new this._EmbedBuilder()
        .setTitle(title)
        .setDescription(description)
        .setColor(color)
        .setTimestamp();
    }
    // Raw embed for webhook mode (no discord.js loaded)
    return {
      title,
      description,
      color,
      timestamp: new Date().toISOString(),
    };
  }

  /** Send at most two distinct, high-confidence short-horizon LLM ideas. */
  async sendActionableIdeas(ideas) {
    if (!this.isConfigured || this._isMuted() || !Array.isArray(ideas)) return false;
    const now = Date.now();
    const windowMs = 6 * 60 * 60 * 1000;
    this._alertedIdeas ??= new Map();
    for (const [key, timestamp] of this._alertedIdeas) {
      if (now - timestamp >= windowMs) this._alertedIdeas.delete(key);
    }
    const fresh = [];
    const seen = new Set();
    for (const input of ideas.slice(0, 64)) {
      if (input?.source === 'rules') continue;
      const idea = normalizeIdeas([input])[0];
      if (!idea || idea.confidence !== 'HIGH' || !['Intraday', 'Days', 'Weeks'].includes(idea.horizon)
        || !['LONG', 'SHORT', 'HEDGE'].includes(idea.type)) continue;
      const key = createHash('sha256').update(`${idea.type}:${idea.ticker}:${idea.title}`.toLowerCase().replace(/\s+/g, ' ').trim()).digest('hex');
      if (seen.has(key) || this._alertedIdeas.has(key)) continue;
      seen.add(key);
      fresh.push({ key, idea });
      if (fresh.length === 2) break;
    }
    if (!fresh.length || !this._checkRateLimit('PRIORITY')) return false;
    const sent = await this.sendMessage(null, fresh.map(({ idea }) => this._buildActionableIdeaEmbed(idea)));
    if (sent) {
      for (const { key } of fresh) this._alertedIdeas.set(key, now);
      this._recordAlert('PRIORITY');
    }
    return !!sent;
  }

  _buildActionableIdeaEmbed(idea) {
    const trim = (value, max, fallback = '—') => {
      const text = typeof value === 'string' ? value.trim() : '';
      return !text ? fallback : text.length <= max ? text : `${text.slice(0, max - 1)}…`;
    };
    const emoji = { LONG: '📈', SHORT: '📉', HEDGE: '🛡️' }[idea.type];
    const color = { LONG: 0x2ECC71, SHORT: 0xE74C3C, HEDGE: 0x95A5A6 }[idea.type];
    const embed = this._embed(trim(`${emoji} ${idea.title}`, 256), trim(idea.rationale, 2000), color);
    const fields = [
      { name: 'Ticker', value: trim(idea.ticker, 80), inline: true },
      { name: 'Direction', value: idea.type, inline: true },
      { name: 'Confidence / Horizon', value: `HIGH · ${idea.horizon}`, inline: true },
    ];
    if (idea.risk) fields.push({ name: 'Risk', value: trim(idea.risk, 800), inline: false });
    if (idea.signals?.length) fields.push({ name: 'Supporting Signals', value: trim(idea.signals.join('\n'), 1024), inline: false });
    const footer = { text: 'Crucix · LLM observation · Verify sources before decisions' };
    if (embed.setFields) {
      embed.setFields(fields);
      embed.setFooter(footer);
    } else {
      embed.fields = fields;
      embed.footer = footer;
    }
    return embed;
  }

  // ─── Rule-Based Fallback (same logic as Telegram) ───────────────────────

  _ruleBasedEvaluation(signals, delta) {
    const criticals = signals.filter(s => s.severity === 'critical');
    const highs = signals.filter(s => s.severity === 'high');
    const nukeSignal = signals.find(s => s.key === 'nuke_anomaly');
    const osintNew = signals.filter(s => s.key?.startsWith('tg_urgent'));
    const marketSignals = signals.filter(s => ['vix', 'hy_spread', 'wti', 'brent', 'natgas', 'gold', 'silver', '10y2y'].includes(s.key));
    const conflictSignals = signals.filter(s => ['conflict_events', 'conflict_fatalities', 'thermal_total'].includes(s.key));

    if (nukeSignal) {
      return { shouldAlert: true, tier: 'FLASH', confidence: 'HIGH', headline: 'Nuclear Anomaly Detected',
        reason: 'Safecast radiation monitors have flagged an anomaly.', actionable: 'Check dashboard immediately.',
        signals: ['nuke_anomaly'], crossCorrelation: 'radiation monitors' };
    }

    const hasCriticalMarket = criticals.some(s => marketSignals.includes(s));
    const hasCriticalConflict = criticals.some(s => conflictSignals.includes(s) || osintNew.includes(s));
    if (criticals.length >= 2 && hasCriticalMarket && hasCriticalConflict) {
      return { shouldAlert: true, tier: 'FLASH', confidence: 'HIGH',
        headline: `${criticals.length} Critical Cross-Domain Signals`,
        reason: `Critical signals across market and conflict domains.`,
        actionable: 'Review dashboard. Assess exposure.',
        signals: criticals.map(s => s.label || s.key).slice(0, 5), crossCorrelation: 'market + conflict' };
    }

    const escalatedHighs = [...criticals, ...highs].filter(s => s.direction === 'up');
    if (escalatedHighs.length >= 2) {
      return { shouldAlert: true, tier: 'PRIORITY', confidence: 'MEDIUM',
        headline: `${escalatedHighs.length} Escalating Signals`,
        reason: `Multiple indicators escalating: ${escalatedHighs.map(s => s.label || s.key).slice(0, 3).join(', ')}.`,
        actionable: 'Monitor for continuation.',
        signals: escalatedHighs.map(s => s.label || s.key).slice(0, 5), crossCorrelation: 'multi-indicator' };
    }

    if (osintNew.length >= 5) {
      return { shouldAlert: true, tier: 'PRIORITY', confidence: 'MEDIUM',
        headline: `OSINT Surge: ${osintNew.length} New Urgent Posts`,
        reason: `${osintNew.length} new urgent OSINT signals. Elevated conflict tempo.`,
        actionable: 'Review OSINT stream.',
        signals: osintNew.map(s => (s.text || '').substring(0, 40)).slice(0, 3), crossCorrelation: 'telegram OSINT' };
    }

    if (criticals.length >= 1 || highs.length >= 3) {
      const top = criticals[0] || highs[0];
      return { shouldAlert: true, tier: 'ROUTINE', confidence: 'LOW',
        headline: top.label || top.reason || 'Signal Change Detected',
        reason: `${criticals.length} critical, ${highs.length} high-severity signals.`,
        actionable: 'Monitor', signals: [...criticals, ...highs].map(s => s.label || s.key).slice(0, 4),
        crossCorrelation: 'single-domain' };
    }

    return { shouldAlert: false, reason: `${signals.length} signals below alert threshold.` };
  }

  // ─── Semantic Dedup (same as Telegram) ──────────────────────────────────

  _contentHash(signal) {
    let content = '';
    if (signal.text) {
      content = signal.text.toLowerCase().replace(/\d{1,2}:\d{2}/g, '').replace(/\d+\.\d+%?/g, 'NUM').replace(/\s+/g, ' ').trim().substring(0, 120);
    } else if (signal.label) {
      content = `${signal.label}:${signal.direction || 'none'}`;
    } else {
      content = signal.key || JSON.stringify(signal).substring(0, 80);
    }
    return createHash('sha256').update(content).digest('hex').substring(0, 16);
  }

  _isSemanticDuplicate(signal) {
    const hash = this._contentHash(signal);
    const lastSeen = this._contentHashes[hash];
    if (!lastSeen) return false;
    return new Date(lastSeen).getTime() > (Date.now() - 4 * 60 * 60 * 1000);
  }

  _recordContentHash(signal) {
    const hash = this._contentHash(signal);
    this._contentHashes[hash] = new Date().toISOString();
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const [h, ts] of Object.entries(this._contentHashes)) {
      if (new Date(ts).getTime() < cutoff) delete this._contentHashes[h];
    }
  }

  _signalKey(signal) {
    if (signal.text) return `dc:${this._contentHash(signal)}`;
    return signal.key || signal.label || JSON.stringify(signal).substring(0, 60);
  }

  // ─── Rate Limiting ──────────────────────────────────────────────────────

  _checkRateLimit(tier) {
    const config = TIER_CONFIG[tier];
    if (!config) return true;
    const now = Date.now();
    const lastSame = this._alertHistory.filter(a => a.tier === tier).pop();
    if (lastSame && (now - lastSame.timestamp) < config.cooldownMs) return false;
    const recentCount = this._alertHistory.filter(a => a.tier === tier && a.timestamp > now - 3600000).length;
    return recentCount < config.maxPerHour;
  }

  _recordAlert(tier) {
    this._alertHistory.push({ tier, timestamp: Date.now() });
    if (this._alertHistory.length > 50) this._alertHistory = this._alertHistory.slice(-50);
  }

  _isMuted() {
    if (!this._muteUntil) return false;
    if (Date.now() > this._muteUntil) { this._muteUntil = null; return false; }
    return true;
  }
}
