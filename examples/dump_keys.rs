//! Debug tool: decrypts a `harness-keys` file and prints its contents to
//! stdout. For inspecting a broken keys file during development only.
//! The output contains every secret in the file, so run it only with a
//! development file and never pipe it anywhere persistent.
use age::secrecy::SecretString;
use std::env;
use std::fs;

use std::io::{self, Read};

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.len() != 2 {
        eprintln!("usage: dump_keys <path>  (password is read from stdin)");
        std::process::exit(2);
    }
    let path = &args[1];
    let mut password = String::new();
    io::stdin().read_to_string(&mut password).expect("read password");
    let password = password.trim_end_matches(['\n', '\r']).to_string();
    let bytes = fs::read(path).expect("read file");
    let identity = age::scrypt::Identity::new(SecretString::from(password.clone()));
    let plain = age::decrypt(&identity, &bytes).expect("decrypt");
    let text = String::from_utf8(plain).expect("utf8");
    print!("{text}");
}