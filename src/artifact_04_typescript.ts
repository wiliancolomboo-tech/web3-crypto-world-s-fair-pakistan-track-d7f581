import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PakflowCore } from "../target/types/pakflow_core";
import { 
  Keypair, 
  PublicKey, 
  SystemProgram, 
  SYSVAR_RENT_PUBKEY 
} from "@solana/web3.js";
import { 
  TOKEN_PROGRAM_ID, 
  createMint, 
  createAccount, 
  mintTo, 
  getAccount 
} from "@solana/spl-token";
import { expect } from "chai";

describe("PakFlow Protocol End-to-End Test Suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.PakflowCore as Program<PakflowCore>;

  let usdcMint: PublicKey;
  let senderTokenAccount: PublicKey;
  let recipientTokenAccount: PublicKey;
  let treasuryTokenAccount: PublicKey;

  const sender = Keypair.generate();
  const recipient = Keypair.generate();
  const treasury = Keypair.generate();

  let platformStatePda: PublicKey;
  const remittanceId = new anchor.BN(892341);
  let escrowStatePda: PublicKey;
  let vaultTokenPda: PublicKey;

  // Mock Pyth Price Account for Devnet/Localnet
  const mockPythAccount = Keypair.generate();

  before(async () => {
    // 1. Airdrop SOL to test actors
    const airdropS = await provider.connection.requestAirdrop(sender.publicKey, 5 * anchor.web3.LAMPORTS_PER_SOL);
    const airdropR = await provider.connection.requestAirdrop(recipient.publicKey, 2 * anchor.web3.LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(airdropS);
    await provider.connection.confirmTransaction(airdropR);

    // 2. Derive PDAs
    [platformStatePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("platform_state")],
      program.programId
    );

    [escrowStatePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("remittance_escrow"), remittanceId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    [vaultTokenPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), escrowStatePda.toBuffer()],
      program.programId
    );

    // 3. Create Mint & Token Accounts
    usdcMint = await createMint(
      provider.connection,
      sender,
      sender.publicKey,
      null,
      6
    );

    senderTokenAccount = await createAccount(
      provider.connection,
      sender,
      usdcMint,
      sender.publicKey
    );

    recipientTokenAccount = await createAccount(
      provider.connection,
      recipient,
      usdcMint,
      recipient.publicKey
    );

    treasuryTokenAccount = await createAccount(
      provider.connection,
      sender,
      usdcMint,
      treasury.publicKey
    );

    // 4. Fund sender with 5,000 USDC
    await mintTo(
      provider.connection,
      sender,
      usdcMint,
      senderTokenAccount,
      sender.publicKey,
      5000 * 1_000_000
    );
  });

  it("1. Initializes the PakFlow Platform with 0.10% (10 BPS) fee", async () => {
    const feeBps = 10; // 0.10%

    await program.methods
      .initializePlatform(feeBps)
      .accounts({
        platformState: platformStatePda,
        authority: provider.wallet.publicKey,
        treasury: treasury.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const state = await program.account.platformState.fetch(platformStatePda);
    expect(state.platformFeeBps).to.equal(10);
    expect(state.treasury.toBase58()).to.equal(treasury.publicKey.toBase58());
    expect(state.totalSettledVolumeUsd.toNumber()).to.equal(0);
  });

  it("2. Fails to initialize platform if fee exceeds 50 BPS (Security Rule)", async () => {
    try {
      const dummyAuthority = Keypair.generate();
      const [dummyState] = PublicKey.findProgramAddressSync([Buffer.from("invalid")], program.programId);
      
      await program.methods
        .initializePlatform(51) // Exceeds cap
        .accounts({
          platformState: dummyState,
          authority: dummyAuthority.publicKey,
          treasury: treasury.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      expect.fail("Should have failed with FeeExceedsMaximum");
    } catch (err: any) {
      expect(err.toString()).to.include("FeeExceedsMaximum");
    }
  });

  it("3. Creates and funds an overseas remittance escrow for Pakistani freelance developer", async () => {
    const depositAmount = new anchor.BN(1500 * 1_000_000); // 1,500 USDC
    const timeoutSeconds = new anchor.BN(86400); // 24 hours

    // Note: For local unit testing, pass mockPythAccount with valid mock memory or local validator fixture
    await program.methods
      .createRemittance(remittanceId, depositAmount, timeoutSeconds)
      .accounts({
        escrowState: escrowStatePda,
        sender: sender.publicKey,
        recipient: recipient.publicKey,
        mint: usdcMint,
        senderTokenAccount: senderTokenAccount,
        vaultTokenAccount: vaultTokenPda,
        pythOraclePkrUsd: mockPythAccount.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([sender])
      .rpc();

    // Verify Vault received 1,500 USDC
    const vaultBal = await getAccount(provider.connection, vaultTokenPda);
    expect(Number(vaultBal.amount)).to.equal(1500 * 1_000_000);

    // Verify Escrow State record
    const escrow = await program.account.remittanceEscrow.fetch(escrowStatePda);
    expect(escrow.amount.toNumber()).to.equal(1500 * 1_000_000);
    expect(escrow.sender.toBase58()).to.equal(sender.publicKey.toBase58());
    expect(escrow.recipient.toBase58()).to.equal(recipient.publicKey.toBase58());
  });

  it("4. Releases escrowed funds to Pakistani recipient, withholding 0.10% protocol fee", async () => {
    await program.methods
      .releaseRemittance(remittanceId)
      .accounts({
        escrowState: escrowStatePda,
        platformState: platformStatePda,
        caller: sender.publicKey,
        recipient: recipient.publicKey,
        vaultTokenAccount: vaultTokenPda,
        recipientTokenAccount: recipientTokenAccount,
        treasuryTokenAccount: treasuryTokenAccount,
        mint: usdcMint,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([sender])
      .rpc();

    // Verification:
    // Amount = 1500 USDC
    // Fee = 1500 * (10 / 10000) = 1.50 USDC
    // Recipient Payout = 1498.50 USDC
    const recipientBal = await getAccount(provider.connection, recipientTokenAccount);
    expect(Number(recipientBal.amount)).to.equal(1498.5 * 1_000_000);

    const treasuryBal = await getAccount(provider.connection, treasuryTokenAccount);
    expect(Number(treasuryBal.amount)).to.equal(1.5 * 1_000_000);

    const state = await program.account.platformState.fetch(platformStatePda);
    expect(state.totalEscrowsCompleted.toNumber()).to.equal(1);
    expect(state.totalSettledVolumeUsd.toNumber()).to.equal(1500 * 1_000_000);
  });

  it("5. Prevents double-claiming or re-entry on settled escrows", async () => {
    try {
      await program.methods
        .releaseRemittance(remittanceId)
        .accounts({
          escrowState: escrowStatePda,
          platformState: platformStatePda,
          caller: sender.publicKey,
          recipient: recipient.publicKey,
          vaultTokenAccount: vaultTokenPda,
          recipientTokenAccount: recipientTokenAccount,
          treasuryTokenAccount: treasuryTokenAccount,
          mint: usdcMint,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([sender])
        .rpc();
      expect.fail("Should not allow re-releasing an escrow");
    } catch (err: any) {
      expect(err.toString()).to.include("EscrowNotActive");
    }
  });
});