use std::io;

enum TransactionType {
    Send,
    Receive,
}

struct Transaction {
    transaction_type: TransactionType,
    amount: f64,
}

struct Wallet {
    name: String,
    balance: f64,
    transactions: Vec<Transaction>,
}

fn read_input() -> String {
    let mut input = String::new();

    io::stdin()
        .read_line(&mut input)
        .expect("Failed to read input");

    input.trim().to_string()
}

fn show_wallet(wallet: &Wallet) {
    println!("\n=== Wallet Information ===");
    println!("Name: {}", wallet.name);
    println!("Balance: {} SOL", wallet.balance);
    println!("Transactions: {}", wallet.transactions.len());
}

fn add_transaction(wallet: &mut Wallet) {
    println!("\nChoose transaction type:");
    println!("1. Send");
    println!("2. Receive");

    let choice = read_input();

    println!("Enter amount in SOL:");

    let amount: f64 = match read_input().parse() {
        Ok(value) => value,
        Err(_) => {
            println!("Invalid amount!");
            return;
        }
    };

    match choice.as_str() {
        "1" => {
            if amount > wallet.balance {
                println!("Not enough SOL!");
                return;
            }

            wallet.balance -= amount;

            wallet.transactions.push(Transaction {
                transaction_type: TransactionType::Send,
                amount,
            });

            println!("Transaction sent successfully!");
        }

        "2" => {
            wallet.balance += amount;

            wallet.transactions.push(Transaction {
                transaction_type: TransactionType::Receive,
                amount,
            });

            println!("Transaction received successfully!");
        }

        _ => {
            println!("Invalid choice!");
        }
    }
}

fn show_transactions(wallet: &Wallet) {
    println!("\n=== Transaction History ===");

    if wallet.transactions.is_empty() {
        println!("No transactions yet.");
        return;
    }

    for (index, transaction) in wallet.transactions.iter().enumerate() {
        match transaction.transaction_type {
            TransactionType::Send => {
                println!("{}. Sent {} SOL", index + 1, transaction.amount);
            }

            TransactionType::Receive => {
                println!("{}. Received {} SOL", index + 1, transaction.amount);
            }
        }
    }
}

fn main() {
    println!("=== Solana Wallet CLI ===");

    println!("Enter wallet name:");
    let name = read_input();

    println!("Enter initial balance in SOL:");

    let balance: f64 = match read_input().parse() {
        Ok(value) => value,
        Err(_) => {
            println!("Invalid balance!");
            return;
        }
    };

    let mut wallet = Wallet {
        name,
        balance,
        transactions: Vec::new(),
    };

    loop {
        println!("\n=== Menu ===");
        println!("1. Show wallet");
        println!("2. Add transaction");
        println!("3. Show transactions");
        println!("4. Exit");
        println!("Choose an option:");

        let choice = read_input();

        match choice.as_str() {
            "1" => show_wallet(&wallet),
            "2" => add_transaction(&mut wallet),
            "3" => show_transactions(&wallet),
            "4" => {
                println!("Goodbye!");
                break;
            }
            _ => println!("Invalid option!"),
        }
    }
}