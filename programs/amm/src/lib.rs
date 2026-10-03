use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Burn, Mint, MintTo, Token, TokenAccount, Transfer};

declare_id!("3mmojyB5aYhqo1VXBYmE3tfUQfTuFkwfnHK4KZ1v66PK");

pub const MINIMUM_LIQUIDITY: u64 = 1_000;
pub const DEFAULT_FEE_BPS: u16 = 30;
pub const BPS_DENOMINATOR: u64 = 10_000;
pub const MAX_FEE_BPS: u16 = 100;

#[program]
pub mod amm {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, fee_bps: u16) -> Result<()> {
        require!(fee_bps <= MAX_FEE_BPS, AmmError::FeeTooHigh);
        require!(
            ctx.accounts.token_a_mint.key() != ctx.accounts.token_b_mint.key(),
            AmmError::IdenticalMints
        );

        let pool = &mut ctx.accounts.pool;
        pool.authority = ctx.accounts.payer.key();
        pool.token_a_mint = ctx.accounts.token_a_mint.key();
        pool.token_b_mint = ctx.accounts.token_b_mint.key();
        pool.lp_mint = ctx.accounts.lp_mint.key();
        pool.vault_a = ctx.accounts.vault_a.key();
        pool.vault_b = ctx.accounts.vault_b.key();
        pool.fee_bps = fee_bps;
        pool.bump = ctx.bumps.pool;
        pool.locked_liquidity = false;

        emit!(PoolInitialized {
            pool: pool.key(),
            token_a_mint: pool.token_a_mint,
            token_b_mint: pool.token_b_mint,
            fee_bps,
        });
        Ok(())
    }

    pub fn add_liquidity(
        ctx: Context<AddLiquidity>,
        amount_a: u64,
        amount_b: u64,
        min_lp: u64,
    ) -> Result<()> {
        require!(amount_a > 0 && amount_b > 0, AmmError::ZeroAmount);

        let reserve_a = ctx.accounts.vault_a.amount;
        let reserve_b = ctx.accounts.vault_b.amount;
        let total_lp = ctx.accounts.lp_mint.supply;

        let liquidity = if total_lp == 0 {
            let product = (amount_a as u128)
                .checked_mul(amount_b as u128)
                .ok_or(AmmError::MathOverflow)?;
            let root = integer_sqrt(product);
            require!(root > MINIMUM_LIQUIDITY as u128, AmmError::InsufficientLiquidity);
            (root as u64)
                .checked_sub(MINIMUM_LIQUIDITY)
                .ok_or(AmmError::MathOverflow)?
        } else {
            let lp_a = (amount_a as u128)
                .checked_mul(total_lp as u128)
                .ok_or(AmmError::MathOverflow)?
                .checked_div(reserve_a as u128)
                .ok_or(AmmError::DivisionByZero)? as u64;
            let lp_b = (amount_b as u128)
                .checked_mul(total_lp as u128)
                .ok_or(AmmError::MathOverflow)?
                .checked_div(reserve_b as u128)
                .ok_or(AmmError::DivisionByZero)? as u64;
            std::cmp::min(lp_a, lp_b)
        };

        require!(liquidity >= min_lp, AmmError::SlippageExceeded);
        require!(liquidity > 0, AmmError::InsufficientLiquidity);

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.user_token_a.to_account_info(),
                    to: ctx.accounts.vault_a.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            amount_a,
        )?;
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.user_token_b.to_account_info(),
                    to: ctx.accounts.vault_b.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            amount_b,
        )?;

        let mint_a = ctx.accounts.pool.token_a_mint;
        let mint_b = ctx.accounts.pool.token_b_mint;
        let bump = ctx.accounts.pool.bump;
        let seeds: &[&[u8]] = &[b"pool", mint_a.as_ref(), mint_b.as_ref(), &[bump]];

        if total_lp == 0 {
            token::mint_to(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    MintTo {
                        mint: ctx.accounts.lp_mint.to_account_info(),
                        to: ctx.accounts.lp_lock.to_account_info(),
                        authority: ctx.accounts.pool.to_account_info(),
                    },
                    &[seeds],
                ),
                MINIMUM_LIQUIDITY,
            )?;
            ctx.accounts.pool.locked_liquidity = true;
        }

        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.lp_mint.to_account_info(),
                    to: ctx.accounts.user_lp.to_account_info(),
                    authority: ctx.accounts.pool.to_account_info(),
                },
                &[seeds],
            ),
            liquidity,
        )?;

        emit!(LiquidityAdded {
            pool: ctx.accounts.pool.key(),
            user: ctx.accounts.user.key(),
            amount_a,
            amount_b,
            lp_minted: liquidity,
        });
        Ok(())
    }

    pub fn remove_liquidity(
        ctx: Context<RemoveLiquidity>,
        lp_amount: u64,
        min_a: u64,
        min_b: u64,
    ) -> Result<()> {
        require!(lp_amount > 0, AmmError::ZeroAmount);

        let reserve_a = ctx.accounts.vault_a.amount;
        let reserve_b = ctx.accounts.vault_b.amount;
        let total_lp = ctx.accounts.lp_mint.supply;
        require!(total_lp > 0, AmmError::EmptyPool);
        require!(lp_amount <= ctx.accounts.user_lp.amount, AmmError::InsufficientLp);

        let amount_a = (lp_amount as u128)
            .checked_mul(reserve_a as u128)
            .ok_or(AmmError::MathOverflow)?
            .checked_div(total_lp as u128)
            .ok_or(AmmError::DivisionByZero)? as u64;
        let amount_b = (lp_amount as u128)
            .checked_mul(reserve_b as u128)
            .ok_or(AmmError::MathOverflow)?
            .checked_div(total_lp as u128)
            .ok_or(AmmError::DivisionByZero)? as u64;

        require!(amount_a >= min_a && amount_b >= min_b, AmmError::SlippageExceeded);
        require!(amount_a > 0 && amount_b > 0, AmmError::InsufficientLiquidity);

        token::burn(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Burn {
                    mint: ctx.accounts.lp_mint.to_account_info(),
                    from: ctx.accounts.user_lp.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            lp_amount,
        )?;

        let seeds: &[&[u8]] = &[
            b"pool",
            ctx.accounts.pool.token_a_mint.as_ref(),
            ctx.accounts.pool.token_b_mint.as_ref(),
            &[ctx.accounts.pool.bump],
        ];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault_a.to_account_info(),
                    to: ctx.accounts.user_token_a.to_account_info(),
                    authority: ctx.accounts.pool.to_account_info(),
                },
                &[seeds],
            ),
            amount_a,
        )?;
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault_b.to_account_info(),
                    to: ctx.accounts.user_token_b.to_account_info(),
                    authority: ctx.accounts.pool.to_account_info(),
                },
                &[seeds],
            ),
            amount_b,
        )?;

        emit!(LiquidityRemoved {
            pool: ctx.accounts.pool.key(),
            user: ctx.accounts.user.key(),
            amount_a,
            amount_b,
            lp_burned: lp_amount,
        });
        Ok(())
    }

    pub fn swap(
        ctx: Context<Swap>,
        amount_in: u64,
        min_out: u64,
        a_to_b: bool,
    ) -> Result<()> {
        require!(amount_in > 0, AmmError::ZeroAmount);

        let reserve_in = if a_to_b {
            ctx.accounts.vault_a.amount
        } else {
            ctx.accounts.vault_b.amount
        };
        let reserve_out = if a_to_b {
            ctx.accounts.vault_b.amount
        } else {
            ctx.accounts.vault_a.amount
        };
        require!(reserve_in > 0 && reserve_out > 0, AmmError::EmptyPool);

        let fee_bps = ctx.accounts.pool.fee_bps as u64;
        let amount_in_less_fee = (amount_in as u128)
            .checked_mul(
                (BPS_DENOMINATOR as u128)
                    .checked_sub(fee_bps as u128)
                    .ok_or(AmmError::MathOverflow)?,
            )
            .ok_or(AmmError::MathOverflow)?
            .checked_div(BPS_DENOMINATOR as u128)
            .ok_or(AmmError::DivisionByZero)?;

        let numerator = amount_in_less_fee
            .checked_mul(reserve_out as u128)
            .ok_or(AmmError::MathOverflow)?;
        let denominator = (reserve_in as u128)
            .checked_add(amount_in_less_fee)
            .ok_or(AmmError::MathOverflow)?;
        let amount_out = numerator
            .checked_div(denominator)
            .ok_or(AmmError::DivisionByZero)? as u64;

        require!(amount_out >= min_out, AmmError::SlippageExceeded);
        require!(amount_out > 0 && amount_out < reserve_out, AmmError::InsufficientLiquidity);

        let seeds: &[&[u8]] = &[
            b"pool",
            ctx.accounts.pool.token_a_mint.as_ref(),
            ctx.accounts.pool.token_b_mint.as_ref(),
            &[ctx.accounts.pool.bump],
        ];

        if a_to_b {
            token::transfer(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.user_token_a.to_account_info(),
                        to: ctx.accounts.vault_a.to_account_info(),
                        authority: ctx.accounts.user.to_account_info(),
                    },
                ),
                amount_in,
            )?;
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.vault_b.to_account_info(),
                        to: ctx.accounts.user_token_b.to_account_info(),
                        authority: ctx.accounts.pool.to_account_info(),
                    },
                    &[seeds],
                ),
                amount_out,
            )?;
        } else {
            token::transfer(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.user_token_b.to_account_info(),
                        to: ctx.accounts.vault_b.to_account_info(),
                        authority: ctx.accounts.user.to_account_info(),
                    },
                ),
                amount_in,
            )?;
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.vault_a.to_account_info(),
                        to: ctx.accounts.user_token_a.to_account_info(),
                        authority: ctx.accounts.pool.to_account_info(),
                    },
                    &[seeds],
                ),
                amount_out,
            )?;
        }

        emit!(Swapped {
            pool: ctx.accounts.pool.key(),
            user: ctx.accounts.user.key(),
            amount_in,
            amount_out,
            a_to_b,
        });
        Ok(())
    }
}

#[account]
pub struct Pool {
    pub authority: Pubkey,
    pub token_a_mint: Pubkey,
    pub token_b_mint: Pubkey,
    pub lp_mint: Pubkey,
    pub vault_a: Pubkey,
    pub vault_b: Pubkey,
    pub fee_bps: u16,
    pub bump: u8,
    pub locked_liquidity: bool,
}

impl Pool {
    pub const LEN: usize = 8 + 32 * 6 + 2 + 1 + 1;
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    pub token_a_mint: Account<'info, Mint>,
    pub token_b_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = payer,
        space = Pool::LEN,
        seeds = [b"pool", token_a_mint.key().as_ref(), token_b_mint.key().as_ref()],
        bump
    )]
    pub pool: Account<'info, Pool>,

    #[account(
        init,
        payer = payer,
        mint::decimals = 6,
        mint::authority = pool,
        seeds = [b"lp_mint", pool.key().as_ref()],
        bump
    )]
    pub lp_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = payer,
        associated_token::mint = token_a_mint,
        associated_token::authority = pool
    )]
    pub vault_a: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = payer,
        associated_token::mint = token_b_mint,
        associated_token::authority = pool
    )]
    pub vault_b: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = payer,
        associated_token::mint = lp_mint,
        associated_token::authority = pool
    )]
    pub lp_lock: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct AddLiquidity<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [b"pool", pool.token_a_mint.as_ref(), pool.token_b_mint.as_ref()],
        bump = pool.bump,
        has_one = vault_a,
        has_one = vault_b,
        has_one = lp_mint,
    )]
    pub pool: Account<'info, Pool>,

    #[account(
        mut,
        constraint = vault_a.mint == pool.token_a_mint @ AmmError::InvalidMint,
        constraint = vault_a.owner == pool.key() @ AmmError::InvalidVaultOwner
    )]
    pub vault_a: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = vault_b.mint == pool.token_b_mint @ AmmError::InvalidMint,
        constraint = vault_b.owner == pool.key() @ AmmError::InvalidVaultOwner
    )]
    pub vault_b: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = lp_mint.key() == pool.lp_mint @ AmmError::InvalidMint
    )]
    pub lp_mint: Account<'info, Mint>,

    #[account(
        mut,
        constraint = user_token_a.mint == pool.token_a_mint @ AmmError::InvalidMint,
        constraint = user_token_a.owner == user.key() @ AmmError::InvalidTokenOwner
    )]
    pub user_token_a: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = user_token_b.mint == pool.token_b_mint @ AmmError::InvalidMint,
        constraint = user_token_b.owner == user.key() @ AmmError::InvalidTokenOwner
    )]
    pub user_token_b: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = user_lp.mint == pool.lp_mint @ AmmError::InvalidMint,
        constraint = user_lp.owner == user.key() @ AmmError::InvalidTokenOwner
    )]
    pub user_lp: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = lp_lock.mint == pool.lp_mint @ AmmError::InvalidMint,
        constraint = lp_lock.owner == pool.key() @ AmmError::InvalidVaultOwner
    )]
    pub lp_lock: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct RemoveLiquidity<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [b"pool", pool.token_a_mint.as_ref(), pool.token_b_mint.as_ref()],
        bump = pool.bump,
        has_one = vault_a,
        has_one = vault_b,
        has_one = lp_mint,
    )]
    pub pool: Account<'info, Pool>,

    #[account(
        mut,
        constraint = vault_a.mint == pool.token_a_mint @ AmmError::InvalidMint,
        constraint = vault_a.owner == pool.key() @ AmmError::InvalidVaultOwner
    )]
    pub vault_a: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = vault_b.mint == pool.token_b_mint @ AmmError::InvalidMint,
        constraint = vault_b.owner == pool.key() @ AmmError::InvalidVaultOwner
    )]
    pub vault_b: Account<'info, TokenAccount>,

    #[account(mut, constraint = lp_mint.key() == pool.lp_mint @ AmmError::InvalidMint)]
    pub lp_mint: Account<'info, Mint>,

    #[account(
        mut,
        constraint = user_token_a.mint == pool.token_a_mint @ AmmError::InvalidMint,
        constraint = user_token_a.owner == user.key() @ AmmError::InvalidTokenOwner
    )]
    pub user_token_a: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = user_token_b.mint == pool.token_b_mint @ AmmError::InvalidMint,
        constraint = user_token_b.owner == user.key() @ AmmError::InvalidTokenOwner
    )]
    pub user_token_b: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = user_lp.mint == pool.lp_mint @ AmmError::InvalidMint,
        constraint = user_lp.owner == user.key() @ AmmError::InvalidTokenOwner
    )]
    pub user_lp: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Swap<'info> {
    pub user: Signer<'info>,

    #[account(
        seeds = [b"pool", pool.token_a_mint.as_ref(), pool.token_b_mint.as_ref()],
        bump = pool.bump,
        has_one = vault_a,
        has_one = vault_b,
    )]
    pub pool: Account<'info, Pool>,

    #[account(
        mut,
        constraint = vault_a.mint == pool.token_a_mint @ AmmError::InvalidMint,
        constraint = vault_a.owner == pool.key() @ AmmError::InvalidVaultOwner
    )]
    pub vault_a: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = vault_b.mint == pool.token_b_mint @ AmmError::InvalidMint,
        constraint = vault_b.owner == pool.key() @ AmmError::InvalidVaultOwner
    )]
    pub vault_b: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = user_token_a.mint == pool.token_a_mint @ AmmError::InvalidMint,
        constraint = user_token_a.owner == user.key() @ AmmError::InvalidTokenOwner
    )]
    pub user_token_a: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = user_token_b.mint == pool.token_b_mint @ AmmError::InvalidMint,
        constraint = user_token_b.owner == user.key() @ AmmError::InvalidTokenOwner
    )]
    pub user_token_b: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[event]
pub struct PoolInitialized {
    pub pool: Pubkey,
    pub token_a_mint: Pubkey,
    pub token_b_mint: Pubkey,
    pub fee_bps: u16,
}

#[event]
pub struct LiquidityAdded {
    pub pool: Pubkey,
    pub user: Pubkey,
    pub amount_a: u64,
    pub amount_b: u64,
    pub lp_minted: u64,
}

#[event]
pub struct LiquidityRemoved {
    pub pool: Pubkey,
    pub user: Pubkey,
    pub amount_a: u64,
    pub amount_b: u64,
    pub lp_burned: u64,
}

#[event]
pub struct Swapped {
    pub pool: Pubkey,
    pub user: Pubkey,
    pub amount_in: u64,
    pub amount_out: u64,
    pub a_to_b: bool,
}

#[error_code]
pub enum AmmError {
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Division by zero")]
    DivisionByZero,
    #[msg("Slippage tolerance exceeded")]
    SlippageExceeded,
    #[msg("Insufficient liquidity")]
    InsufficientLiquidity,
    #[msg("Insufficient LP tokens")]
    InsufficientLp,
    #[msg("Pool is empty")]
    EmptyPool,
    #[msg("Invalid mint")]
    InvalidMint,
    #[msg("Invalid vault owner")]
    InvalidVaultOwner,
    #[msg("Invalid token account owner")]
    InvalidTokenOwner,
    #[msg("Fee exceeds maximum allowed")]
    FeeTooHigh,
    #[msg("Token mints must be different")]
    IdenticalMints,
}

fn integer_sqrt(n: u128) -> u128 {
    if n == 0 {
        return 0;
    }
    let mut x = n;
    let mut y = (x + 1) / 2;
    while y < x {
        x = y;
        y = (x + n / x) / 2;
    }
    x
}

#[cfg(test)]
mod unit_tests {
    use super::*;

    #[test]
    fn sqrt_perfect_square() {
        assert_eq!(integer_sqrt(0), 0);
        assert_eq!(integer_sqrt(1), 1);
        assert_eq!(integer_sqrt(9), 3);
        assert_eq!(integer_sqrt(1_000_000), 1_000);
    }

    #[test]
    fn sqrt_rounds_down() {
        assert_eq!(integer_sqrt(10), 3);
        assert_eq!(integer_sqrt(99), 9);
    }

    #[test]
    fn fee_math_matches_expected() {
        let amount_in: u128 = 1_000_000;
        let fee_bps: u128 = DEFAULT_FEE_BPS as u128;
        let less = amount_in * (BPS_DENOMINATOR as u128 - fee_bps) / BPS_DENOMINATOR as u128;
        assert_eq!(less, 997_000);
    }
}
