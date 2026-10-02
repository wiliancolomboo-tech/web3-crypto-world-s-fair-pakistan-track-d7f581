import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import { Program, AnchorProvider, Wallet, Idl, EventParser } from "@coral-xyz/anchor";
import { Resend } from "resend";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const RESEND_API_KEY = process.env.RESEND_API_KEY || "re_mock_test_key_12345678";
const BANKING_WEBHOOK_URL = process.env.BANKING_WEBHOOK_URL || "https://httpbin.org/post";
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || "https://httpbin.org/post";
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID || "PakF1ow111111111111111111111111111111111111");

const resend = new Resend(RESEND_API_KEY);

interface RemittanceEventData {
  remittanceId: string;
  sender: string;
  recipient: string;
  amountUsdc: number;
  pkrRate: number;
  timestamp: string;
}

export class PakFlowAutomationWorker {
  private connection: Connection;
  private processedSignatures: Set<string>;

  constructor() {
    this.connection = new Connection(SOLANA_RPC_URL, {
      commitment: "confirmed",
      wsEndpoint: SOLANA_RPC_URL.replace("https", "wss").replace("http", "ws"),
    });
    this.processedSignatures = new Set<string>();
  }

  public async start(): Promise<void> {
    console.log(`[PakFlow Worker] Booting listener for Program: ${PROGRAM_ID.toBase58()}`);
    console.log(`[PakFlow Worker] Connected to Solana RPC: ${SOLANA_RPC_URL}`);

    // Subscribe to Program account logs
    this.connection.onLogs(
      PROGRAM_ID,
      async (logs, ctx) => {
        if (logs.err) return;
        if (this.processedSignatures.has(logs.signature)) return;
        this.processedSignatures.add(logs.signature);

        console.log(`\n>>> [Event Detected] Signature: ${logs.signature}`);
        await this.handleLogEntry(logs.logs, logs.signature);
      },
      "confirmed"
    );

    console.log(`[PakFlow Worker] Real-time daemon active. Awaiting Solana transactions...`);
  }

  private async handleLogEntry(logs: string[], signature: string): Promise<void> {
    for (const line of logs) {
      if (line.includes("RemittanceDeposited") || line.includes("Instruction: CreateRemittance")) {
        // Mock structured payload extraction (simulated from Anchor event parser)
        const mockPayload: RemittanceEventData = {
          remittanceId: `PK-${Date.now().toString().slice(-6)}`,
          sender: "8sZT...US_CLIENT",
          recipient: "4kWP...PAK_DEV",
          amountUsdc: 2500.0,
          pkrRate: 278.45,
          timestamp: new Date().toISOString(),
        };

        await this.dispatchEnterpriseNotifications(mockPayload, signature);
        break;
      }
    }
  }

  private async dispatchEnterpriseNotifications(
    data: RemittanceEventData,
    txSignature: string
  ): Promise<void> {
    const pkrEquivalent = (data.amountUsdc * data.pkrRate).toLocaleString("en-PK", {
      maximumFractionDigits: 2,
    });

    console.log(`[PakFlow Worker] Dispatching Enterprise Pipeline for ID: ${data.remittanceId}`);

    // 1. Dispatch 1LINK / Raast Banking Switch Webhook
    try {
      const bankPayload = {
        switchSource: "SOLANA_MAINNET_SETTLEMENT",
        pakflowRemittanceId: data.remittanceId,
        destinationIban: "PK36SCBL0000001123456701",
        pkrTotalCredited: data.amountUsdc * data.pkrRate,
        proofOfSettlementHash: txSignature,
        clearingRail: "RAAST_P2P_INSTANT",
      };

      const bankRes = await axios.post(BANKING_WEBHOOK_URL, bankPayload, { timeout: 5000 });
      console.log(`[Raast Gateway] Dispatched successfully. Status: ${bankRes.status}`);
    } catch (err: any) {
      console.error(`[Raast Gateway Error] Failed to ping bank API: ${err.message}`);
    }

    // 2. Dispatch Bilingual FBR-Compliant Email Receipt via Resend
    try {
      const emailHtml = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e0e0e0; border-radius: 8px; overflow: hidden;">
          <div style="background-color: #0b6623; color: white; padding: 24px; text-align: center;">
            <h1 style="margin: 0; font-size: 24px;">پاک فلو - رسیدِ ترسیلِ زر</h1>
            <h3 style="margin: 4px 0 0 0; font-weight: normal;">PakFlow Official Proof of Remittance</h3>
          </div>
          <div style="padding: 24px;">
            <p>Dear Valued Recipient,</p>
            <p>Your cross-border wage remittance of <strong>$${data.amountUsdc.toFixed(2)} USDC</strong> has been securely locked and settled via Solana blockchain.</p>
            
            <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
              <tr style="border-bottom: 1px solid #ddd;">
                <td style="padding: 8px; color: #666;">Remittance Track ID</td>
                <td style="padding: 8px; font-weight: bold;">${data.remittanceId}</td>
              </tr>
              <tr style="border-bottom: 1px solid #ddd;">
                <td style="padding: 8px; color: #666;">Pyth Network Oracle Rate</td>
                <td style="padding: 8px; font-weight: bold;">1 USD = ${data.pkrRate} PKR</td>
              </tr>
              <tr style="border-bottom: 1px solid #ddd;">
                <td style="padding: 8px; color: #666;">Estimated Net PKR Value</td>
                <td style="padding: 8px; font-weight: bold; color: #0b6623;">PKR ${pkrEquivalent}</td>
              </tr>
              <tr style="border-bottom: 1px solid #ddd;">
                <td style="padding: 8px; color: #666;">Solana Signature</td>
                <td style="padding: 8px; font-family: monospace; font-size: 11px;">${txSignature.slice(0, 32)}...</td>
              </tr>
            </table>

            <div style="background-color: #f7f9fa; padding: 12px; border-radius: 6px; font-size: 12px; color: #555;">
              Notice: This electronic receipt serves as verifiable proof-of-export income under Section 154A of the Income Tax Ordinance for Pakistan-based freelance software exporters.
            </div>
          </div>
        </div>
      `;

      const emailResponse = await resend.emails.send({
        from: "PakFlow Remit <onboarding@resend.dev>",
        to: ["pakistan-freelancer-demo@mailinator.com"],
        subject: `[Settled] PKR ${pkrEquivalent} Credited via PakFlow (ID: ${data.remittanceId})`,
        html: emailHtml,
      });

      console.log(`[Resend Engine] Receipt delivered successfully. ID: ${emailResponse.data?.id}`);
    } catch (err: any) {
      console.error(`[Resend Engine Error] Delivery failure: ${err.message}`);
    }

    // 3. Dispatch Operations & Compliance Audit Ping to Slack
    try {
      await axios.post(SLACK_WEBHOOK_URL, {
        text: `⚡ *PakFlow Remittance Escrow Settled*\n• *Remittance ID:* \`${data.remittanceId}\`\n• *Amount:* \`$${data.amountUsdc.toFixed(2)} USDC\` (~PKR ${pkrEquivalent})\n• *Pyth Rate:* \`PKR ${data.pkrRate}\`\n• *Solana TX:* https://explorer.solana.com/tx/${txSignature}?cluster=devnet`,
      });
      console.log(`[Slack Ops] Audit alert emitted.`);
    } catch (err: any) {
      console.error(`[Slack Ops Error] ${err.message}`);
    }
  }
}

// Direct Execution Trigger
if (require.main === module) {
  const worker = new PakFlowAutomationWorker();
  worker.start().catch((err) => {
    console.error("Fatal Worker Exception:", err);
    process.exit(1);
  });
}