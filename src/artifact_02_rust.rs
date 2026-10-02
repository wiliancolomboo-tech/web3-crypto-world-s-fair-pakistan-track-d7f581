use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
use pyth_sdk_solana::load_price_feed_from_account_info;

declare_id!("PakF1ow111111111111111111111111111111111111");

pub const ESCROW_SEED: &[u8] = b"remittance_escrow";
pub const PLATFORM_SEED: &[u8] = b"platform_state";
pub const MAXIMUM_ORACLE_AGE_SECONDS: u64 = 120; // 2 minutes max staleness

#[program]
pub mod pakflow_core {
    use super::*;

    /// Initializes global platform configuration and fee treasury
    pub fn initialize_platform(
        ctx: Context<InitializePlatform>,
        platform_fee_bps: u16,
    ) -> Result<()> {
        require!(platform_fee_bps <= 50, PakFlowError::FeeExceedsMaximum); // Max 0.50%
        let state = &mut ctx.accounts.platform_state;
        state.authority = ctx.accounts.authority.key();
        state.treasury = ctx.accounts.treasury.key();
        state.platform_fee_bps = platform_fee_bps;
        state.total_settled_volume_usd = 0;
        state.total_escrows_completed = 0;
        state.bump = ctx.bumps.platform_state;
        Ok(())
    }

    /// Creates a deterministic remittance escrow funded with SPL USDC/USDT
    pub fn create_remittance(
        ctx: Context<CreateRemittance>,
        remittance_id: u64,
        amount: u64,
        auto_release_timeout_seconds: i64,
    ) -> Result<()> {
        require!(amount > 0, PakFlowError::InvalidAmount);
        require!(
            auto_release_timeout_seconds >= 3600 && auto_release_timeout_seconds <= 2592000,
            PakFlowError::InvalidTimeout
        ); // 1 hour to 30 days

        // 1. Fetch Pyth USD/PKR Exchange Rate for real-time tracking
        let pyth_price_info = &ctx.accounts.pyth_oracle_pkr_usd;
        let price_feed = load_price_feed_from_account_info(pyth_price_info)
            .map_err(|_| error!(PakFlowError::InvalidOracleAccount))?;
        
        let current_time = Clock::get()?.unix_timestamp;
        let price = price_feed
            .get_price_no_older_than(current_time, MAXIMUM_ORACLE_AGE_SECONDS)
            .ok_or(error!(PakFlowError::StalePriceFeed))?;

        require!(price.price > 0, PakFlowError::InvalidPrice);

        // 2. Transfer SPL tokens from sender to Escrow PDA Token Vault
        let cpi_accounts = Transfer {
            from: ctx.accounts.sender_token_account.to_account_info(),
            to: ctx.accounts.vault_token_account.to_account_info(),
            authority: ctx.accounts.sender.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        token::transfer(CpiContext::new(cpi_program, cpi_accounts), amount)?;

        // 3. Populate Escrow State
        let escrow = &mut ctx.accounts.escrow_state;
        escrow.remittance_id = remittance_id;
        escrow.sender = ctx.accounts.sender.key();
        escrow.recipient = ctx.accounts.recipient.key();
        escrow.mint = ctx.accounts.mint.key();
        escrow.amount = amount;
        escrow.pkr_price_snapshot = price.price;
        escrow.pkr_price_exponent = price.expo;
        escrow.created_at = current_time;
        escrow.deadline = current_time.checked_add(auto_release_timeout_seconds).unwrap();
        escrow.status = RemittanceStatus::Funded;
        escrow.bump = ctx.bumps.escrow_state;

        emit!(RemittanceDeposited {
            remittance_id,
            sender: escrow.sender,
            recipient: escrow.recipient,
            amount,
            pkr_exchange_rate: price.price,
            exponent: price.expo,
            created_at: current_time,
        });

        Ok(())
    }

    /// Releases escrowed funds to Pakistani recipient and distributes platform fee
    pub fn release_remittance(ctx: Context<ReleaseRemittance>, remittance_id: u64) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow_state;
        require!(escrow.status == RemittanceStatus::Funded, PakFlowError::EscrowNotActive);

        // Calculate fee
        let platform_state = &mut ctx.accounts.platform_state;
        let fee_amount = (escrow.amount as u128)
            .checked_mul(platform_state.platform_fee_bps as u128)
            .unwrap()
            .checked_div(10000)
            .unwrap() as u64;
        let recipient_payout = escrow.amount.checked_sub(fee_amount).unwrap();

        let escrow_bump = escrow.bump;
        let remittance_id_bytes = remittance_id.to_le_bytes();
        let seeds: &[&[u8]] = &[
            ESCROW_SEED,
            remittance_id_bytes.as_ref(),
            &[escrow_bump],
        ];
        let signer_seeds = &[&seeds[..]];

        // 1. Transfer to Pakistani recipient
        let cpi_accounts_recipient = Transfer {
            from: ctx.accounts.vault_token_account.to_account_info(),
            to: ctx.accounts.recipient_token_account.to_account_info(),
            authority: escrow.to_account_info(),
        };
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                cpi_accounts_recipient,
                signer_seeds,
            ),
            recipient_payout,
        )?;

        // 2. Transfer fee to Treasury
        if fee_amount > 0 {
            let cpi_accounts_fee = Transfer {
                from: ctx.accounts.vault_token_account.to_account_info(),
                to: ctx.accounts.treasury_token_account.to_account_info(),
                authority: escrow.to_account_info(),
            };
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    cpi_accounts_fee,
                    signer_seeds,
                ),
                fee_amount,
            )?;
        }

        // 3. Update States
        escrow.status = RemittanceStatus::Settled;
        platform_state.total_settled_volume_usd = platform_state
            .total_settled_volume_usd
            .checked_add(escrow.amount)
            .unwrap();
        platform_state.total_escrows_completed = platform_state
            .total_escrows_completed
            .checked_add(1)
            .unwrap();

        emit!(RemittanceReleased {
            remittance_id,
            recipient: escrow.recipient,
            amount_payout: recipient_payout,
            fee_deducted: fee_amount,
            settled_at: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// Sender or Recipient refund in case of timeout expiry
    pub fn claim_timeout_refund(ctx: Context<ClaimTimeoutRefund>, remittance_id: u64) -> Result<()> {
        let escrow = &mut ctx.accounts.escrow_state;
        let current_time = Clock::get()?.unix_timestamp;

        require!(escrow.status == RemittanceStatus::Funded, PakFlowError::EscrowNotActive);
        require!(current_time >= escrow.deadline, PakFlowError::TimeoutNotReached);

        let escrow_bump = escrow.bump;
        let remittance_id_bytes = remittance_id.to_le_bytes();
        let seeds: &[&[u8]] = &[
            ESCROW_SEED,
            remittance_id_bytes.as_ref(),
            &[escrow_bump],
        ];
        let signer_seeds = &[&seeds[..]];

        let cpi_accounts = Transfer {
            from: ctx.accounts.vault_token_account.to_account_info(),
            to: ctx.accounts.sender_token_account.to_account_info(),
            authority: escrow.to_account_info(),
        };
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                cpi_accounts,
                signer_seeds,
            ),
            escrow.amount,
        )?;

        escrow.status = RemittanceStatus::Refunded;

        emit!(RemittanceRefunded {
            remittance_id,
            refund_amount: escrow.amount,
            refunded_to: escrow.sender,
            timestamp: current_time,
        });

        Ok(())
    }
}

// ---------------------------------------------------------------------------
// DATA ACCOUNTS & STRUCTS
// ---------------------------------------------------------------------------

#[account]
pub struct PlatformState {
    pub authority: Pubkey,
    pub treasury: Pubkey,
    pub platform_fee_bps: u16,
    pub total_settled_volume_usd: u64,
    pub total_escrows_completed: u64,
    pub bump: u8,
}

impl PlatformState {
    pub const LEN: usize = 8 + 32 + 32 + 2 + 8 + 8 + 1;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum RemittanceStatus {
    Funded,
    Settled,
    Refunded,
}

#[account]
pub struct RemittanceEscrow {
    pub remittance_id: u64,
    pub sender: Pubkey,
    pub recipient: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
    pub pkr_price_snapshot: i64,
    pub pkr_price_exponent: i32,
    pub created_at: i64,
    pub deadline: i64,
    pub status: RemittanceStatus,
    pub bump: u8,
}

impl RemittanceEscrow {
    pub const LEN: usize = 8 + 8 + 32 + 32 + 32 + 8 + 8 + 4 + 8 + 8 + 1 + 1;
}

// ---------------------------------------------------------------------------
// INSTRUCTION CONTEXTS
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct InitializePlatform<'info> {
    #[account(
        init,
        payer = authority,
        space = PlatformState::LEN,
        seeds = [PLATFORM_SEED],
        bump
    )]
    pub platform_state: Account<'info, PlatformState>,
    #[account(mut)]
    pub authority: Signer<'info>,
    /// CHECK: Treasury account for fee accrual
    pub treasury: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(remittance_id: u64)]
pub struct CreateRemittance<'info> {
    #[account(
        init,
        payer = sender,
        space = RemittanceEscrow::LEN,
        seeds = [ESCROW_SEED, &remittance_id.to_le_bytes()],
        bump
    )]
    pub escrow_state: Account<'info, RemittanceEscrow>,

    #[account(mut)]
    pub sender: Signer<'info>,

    /// CHECK: The Pakistani recipient wallet
    pub recipient: AccountInfo<'info>,

    pub mint: Account<'info, Mint>,

    #[account(
        mut,
        constraint = sender_token_account.owner == sender.key(),
        constraint = sender_token_account.mint == mint.key()
    )]
    pub sender_token_account: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = sender,
        token::mint = mint,
        token::authority = escrow_state,
        seeds = [b"vault", escrow_state.key().as_ref()],
        bump
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    /// CHECK: Pyth Network price account (PKR/USD or USD/PKR)
    pub pyth_oracle_pkr_usd: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
#[instruction(remittance_id: u64)]
pub struct ReleaseRemittance<'info> {
    #[account(
        mut,
        seeds = [ESCROW_SEED, &remittance_id.to_le_bytes()],
        bump = escrow_state.bump,
        has_one = recipient,
        has_one = mint
    )]
    pub escrow_state: Account<'info, RemittanceEscrow>,

    #[account(
        mut,
        seeds = [PLATFORM_SEED],
        bump = platform_state.bump
    )]
    pub platform_state: Account<'info, PlatformState>,

    /// Signer can be Sender (approving work) or Recipient (if dispute resolution rules match)
    pub caller: Signer<'info>,

    /// CHECK: Recipient pubkey from escrow
    #[account(mut)]
    pub recipient: AccountInfo<'info>,

    #[account(
        mut,
        seeds = [b"vault", escrow_state.key().as_ref()],
        bump
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = recipient_token_account.owner == recipient.key(),
        constraint = recipient_token_account.mint == mint.key()
    )]
    pub recipient_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = treasury_token_account.owner == platform_state.treasury,
        constraint = treasury_token_account.mint == mint.key()
    )]
    pub treasury_token_account: Account<'info, TokenAccount>,

    pub mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(remittance_id: u64)]
pub struct ClaimTimeoutRefund<'info> {
    #[account(
        mut,
        seeds = [ESCROW_SEED, &remittance_id.to_le_bytes()],
        bump = escrow_state.bump,
        has_one = sender
    )]
    pub escrow_state: Account<'info, RemittanceEscrow>,

    #[account(mut)]
    pub sender: Signer<'info>,

    #[account(
        mut,
        seeds = [b"vault", escrow_state.key().as_ref()],
        bump
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = sender_token_account.owner == sender.key()
    )]
    pub sender_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

// ---------------------------------------------------------------------------
// EVENTS & ERRORS
// ---------------------------------------------------------------------------

#[event]
pub struct RemittanceDeposited {
    pub remittance_id: u64,
    pub sender: Pubkey,
    pub recipient: Pubkey,
    pub amount: u64,
    pub pkr_exchange_rate: i64,
    pub exponent: i32,
    pub created_at: i64,
}

#[event]
pub struct RemittanceReleased {
    pub remittance_id: u64,
    pub recipient: Pubkey,
    pub amount_payout: u64,
    pub fee_deducted: u64,
    pub settled_at: i64,
}

#[event]
pub struct RemittanceRefunded {
    pub remittance_id: u64,
    pub refund_amount: u64,
    pub refunded_to: Pubkey,
    pub timestamp: i64,
}

#[error_code]
pub enum PakFlowError {
    #[msg("Platform fee cannot exceed 50 basis points (0.50%)")]
    FeeExceedsMaximum,
    #[msg("Remittance amount must be greater than zero")]
    InvalidAmount,
    #[msg("Auto-release timeout must be between 1 hour and 30 days")]
    InvalidTimeout,
    #[msg("Escrow account is not in an active funded state")]
    EscrowNotActive,
    #[msg("Escrow timeout has not elapsed yet")]
    TimeoutNotReached,
    #[msg("Invalid Pyth oracle account")]
    InvalidOracleAccount,
    #[msg("Pyth price feed is stale or unavailable")]
    StalePriceFeed,
    #[msg("Pyth oracle reported a non-positive exchange rate")]
    InvalidPrice,
}