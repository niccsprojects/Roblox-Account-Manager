pub mod accounts;
pub mod crypto;
pub mod scripts;
pub mod settings;
pub mod vault_key;
pub mod versions;

pub fn vault_recovery_candidates(settings: &settings::SettingsStore) -> Vec<Vec<u8>> {
    let mut hashes: Vec<Vec<u8>> = Vec::new();
    let mut push = |identifier: &str| {
        let identifier = identifier.trim();
        if identifier.is_empty() {
            return;
        }
        let hash = crypto::device_hash_for_identifier(identifier);
        if !hashes.contains(&hash) {
            hashes.push(hash);
        }
    };
    push(&settings.get_string("Isolation", "BackupMachineGuid"));
    for identifier in settings
        .get_string("Isolation", "MachineGuidHistory")
        .split(',')
    {
        push(identifier);
    }
    hashes
}
