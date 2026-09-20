use argon2::{Argon2, PasswordHasher};

fn main() -> anyhow::Result<()> {
    let mut args = std::env::args_os().skip(1);
    let password = if let Some(password) = args.next() {
        anyhow::ensure!(
            args.next().is_none(),
            "expected at most one password argument"
        );
        password
            .into_string()
            .map_err(|_| anyhow::anyhow!("password argument must be valid UTF-8"))?
    } else {
        let password = rpassword::prompt_password("Password: ")?;
        let confirmation = rpassword::prompt_password("Confirm password: ")?;
        anyhow::ensure!(password == confirmation, "passwords do not match");
        password
    };
    anyhow::ensure!(password.len() >= 16, "password must be at least 16 bytes");
    let hash = Argon2::default()
        .hash_password(password.as_bytes())
        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    println!("{hash}");
    Ok(())
}
