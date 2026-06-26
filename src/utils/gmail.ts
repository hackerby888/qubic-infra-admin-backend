import nodemailer from "nodemailer";
import { logger } from "./logger.js";

const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 587,
    secure: false, // STARTTLS — required because 465 is firewalled on prod
    requireTLS: true,
    auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD,
    },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
});

function getAlertRecipients(): string[] {
    return (process.env.ALERT_EMAIL_RECIPIENTS || "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
}

export namespace Gmail {
    let verified = false;
    export async function verify(timeoutMs = 15_000): Promise<boolean> {
        try {
            const timeout = new Promise<never>((_, reject) =>
                setTimeout(
                    () => reject(new Error(`verify timed out after ${timeoutMs}ms`)),
                    timeoutMs
                )
            );
            await Promise.race([transporter.verify(), timeout]);
            verified = true;
            logger.info("📧 Gmail transporter verified.");
            return true;
        } catch (error) {
            logger.error(
                `📧 Gmail transporter verify failed: ${(error as Error).message}`
            );
            return false;
        }
    }

    export async function sendEmail(
        mailOptions: nodemailer.SendMailOptions
    ): Promise<boolean> {
        try {
            const info = await transporter.sendMail(mailOptions);
            logger.info(`📧 Email sent. Message ID: ${info.messageId}`);
            return true;
        } catch (error) {
            logger.error(`📧 Email send failed: ${(error as Error).message}`);
            return false;
        }
    }

    export async function sendMainNodeLaggingEmail({
        nodeIp,
        behindTicks,
    }: {
        nodeIp: string;
        behindTicks: number;
    }): Promise<boolean> {
        const recipients = getAlertRecipients();
        if (recipients.length === 0) {
            logger.warn(
                "📧 ALERT_EMAIL_RECIPIENTS is empty — skipping lagging email."
            );
            return false;
        }
        return sendEmail({
            from: `"Qubic Global Automated Sender" <${process.env.GMAIL_USER}>`,
            to: recipients,
            subject: `Main node ${nodeIp} is lagging ${behindTicks} ticks behind!`,
            text: `The main node at IP ${nodeIp} is lagging behind by ${behindTicks} ticks. Please check the node status.`,
            html: `<b>The main node at IP ${nodeIp}</b> is lagging behind by <i>${behindTicks}</i> ticks. Please check the node status.`,
        });
    }

    export async function sendMainNodeRecoveredEmail({
        nodeIp,
    }: {
        nodeIp: string;
    }): Promise<boolean> {
        const recipients = getAlertRecipients();
        if (recipients.length === 0) return false;
        return sendEmail({
            from: `"Qubic Global Automated Sender" <${process.env.GMAIL_USER}>`,
            to: recipients,
            subject: `Main node ${nodeIp} has recovered`,
            text: `The main node at IP ${nodeIp} is back in sync with the network.`,
            html: `<b>The main node at IP ${nodeIp}</b> is back in sync with the network.`,
        });
    }

    export async function sendMainNodeFailoverEmail({
        type,
        server,
        groupId,
        reason,
        tick,
    }: {
        type: "promote" | "demote";
        server: string;
        groupId: string;
        reason: string;
        tick: number;
    }): Promise<boolean> {
        const recipients = getAlertRecipients();
        if (recipients.length === 0) return false;
        const action =
            type === "promote" ? "promoted to Main" : "demoted from Main";
        const shortGroup = groupId.slice(0, 8);
        return sendEmail({
            from: `"Qubic Global Automated Sender" <${process.env.GMAIL_USER}>`,
            to: recipients,
            subject: `Lite node ${server} ${action} (group ${shortGroup})`,
            text: `Lite node ${server} was ${action} in group ${shortGroup}. Reason: ${reason}. Tick: ${tick}.`,
            html: `<b>Lite node ${server}</b> was <b>${action}</b> in group <code>${shortGroup}</code>.<br/>Reason: <i>${reason}</i><br/>Tick: <code>${tick}</code>`,
        });
    }

    export async function sendServerStartedEmail({
        port,
    }: {
        port: number | string;
    }): Promise<boolean> {
        const recipients = getAlertRecipients();
        if (recipients.length === 0) return false;
        const host = process.env.HOSTNAME || "unknown-host";
        const at = new Date().toISOString();
        return sendEmail({
            from: `"Qubic Global Automated Sender" <${process.env.GMAIL_USER}>`,
            to: recipients,
            subject: `Backend started on ${host}:${port}`,
            text: `Qubic backend started on ${host}:${port} at ${at}.`,
            html: `<b>Qubic backend started</b> on <code>${host}:${port}</code> at <code>${at}</code>.`,
        });
    }

    export async function sendServerStoppedEmail({
        reason,
    }: {
        reason: string;
    }): Promise<boolean> {
        const recipients = getAlertRecipients();
        if (recipients.length === 0) return false;
        const host = process.env.HOSTNAME || "unknown-host";
        const at = new Date().toISOString();
        return sendEmail({
            from: `"Qubic Global Automated Sender" <${process.env.GMAIL_USER}>`,
            to: recipients,
            subject: `Backend stopped on ${host} (${reason})`,
            text: `Qubic backend on ${host} is shutting down at ${at}. Reason: ${reason}.`,
            html: `<b>Qubic backend on ${host}</b> is shutting down at <code>${at}</code>. Reason: <i>${reason}</i>.`,
        });
    }

    export async function sendNodeDownEmail({
        server,
        service,
    }: {
        server: string;
        service: string;
    }): Promise<boolean> {
        const recipients = getAlertRecipients();
        if (recipients.length === 0) return false;
        const at = new Date().toISOString();
        return sendEmail({
            from: `"Qubic Global Automated Sender" <${process.env.GMAIL_USER}>`,
            to: recipients,
            subject: `⛔ Node DOWN: ${server} (${service})`,
            text: `Managed ${service} node ${server} is DOWN (unreachable or tick frozen for over 2 minutes) as of ${at}. Please check the host.`,
            html: `<b>⛔ Managed ${service} node ${server} is DOWN</b> (unreachable or tick frozen for over 2 minutes) as of <code>${at}</code>. Please check the host.`,
        });
    }

    export async function sendNodeRecoveredEmail({
        server,
        service,
    }: {
        server: string;
        service: string;
    }): Promise<boolean> {
        const recipients = getAlertRecipients();
        if (recipients.length === 0) return false;
        return sendEmail({
            from: `"Qubic Global Automated Sender" <${process.env.GMAIL_USER}>`,
            to: recipients,
            subject: `✅ Node recovered: ${server} (${service})`,
            text: `Managed ${service} node ${server} is back online.`,
            html: `<b>✅ Managed ${service} node ${server}</b> is back online.`,
        });
    }

    export async function sendDbDownEmail({
        error,
    }: {
        error: string;
    }): Promise<boolean> {
        const recipients = getAlertRecipients();
        if (recipients.length === 0) return false;
        const host = process.env.HOSTNAME || "unknown-host";
        const at = new Date().toISOString();
        return sendEmail({
            from: `"Qubic Global Automated Sender" <${process.env.GMAIL_USER}>`,
            to: recipients,
            subject: `⛔ MongoDB UNREACHABLE (reported by ${host})`,
            text: `Backend instance ${host} cannot reach MongoDB as of ${at}. Error: ${error}.`,
            html: `<b>⛔ MongoDB unreachable</b> — reported by instance <code>${host}</code> at <code>${at}</code>.<br/>Error: <i>${error}</i>`,
        });
    }

    export async function sendDbRecoveredEmail({
        downForMs,
    }: {
        downForMs: number;
    }): Promise<boolean> {
        const recipients = getAlertRecipients();
        if (recipients.length === 0) return false;
        const host = process.env.HOSTNAME || "unknown-host";
        const secs = Math.round(downForMs / 1000);
        return sendEmail({
            from: `"Qubic Global Automated Sender" <${process.env.GMAIL_USER}>`,
            to: recipients,
            subject: `✅ MongoDB recovered (reported by ${host})`,
            text: `Backend instance ${host} reconnected to MongoDB after ${secs}s.`,
            html: `<b>✅ MongoDB recovered</b> — instance <code>${host}</code> reconnected after <code>${secs}s</code>.`,
        });
    }

    // Suppress unused warning when verified is read elsewhere
    export function isVerified() {
        return verified;
    }
}
