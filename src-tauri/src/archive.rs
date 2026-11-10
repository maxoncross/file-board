// Архивы: упаковка и распаковка через WinRAR (если установлен),
// иначе — через встроенный в Windows tar.exe (zip для упаковки; распаковка zip/rar/7z/tar…).

use serde::Serialize;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn reg_string(root: windows::Win32::System::Registry::HKEY, key: &str, value: Option<&str>) -> Option<String> {
    use windows::core::HSTRING;
    use windows::Win32::System::Registry::*;
    let key_h = HSTRING::from(key);
    let val_h = value.map(HSTRING::from);
    let val_p = match &val_h {
        Some(v) => windows::core::PCWSTR(v.as_ptr()),
        None => windows::core::PCWSTR::null(),
    };
    let mut buf = vec![0u16; 1024];
    let mut size = (buf.len() * 2) as u32;
    unsafe {
        RegGetValueW(
            root,
            &key_h,
            val_p,
            RRF_RT_REG_SZ,
            None,
            Some(buf.as_mut_ptr() as *mut _),
            Some(&mut size),
        )
        .ok()
        .ok()?;
    }
    let n = (size as usize / 2).saturating_sub(1);
    let s = String::from_utf16_lossy(&buf[..n.min(buf.len())]);
    let s = s.trim_end_matches('\0').trim().to_string();
    (!s.is_empty()).then_some(s)
}

pub fn find_winrar() -> Option<PathBuf> {
    use windows::Win32::System::Registry::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    let mut cands: Vec<PathBuf> = Vec::new();
    for root in [HKEY_LOCAL_MACHINE, HKEY_CURRENT_USER] {
        if let Some(p) = reg_string(root, r"SOFTWARE\WinRAR", Some("exe64")) {
            cands.push(p.into());
        }
        if let Some(p) = reg_string(root, r"SOFTWARE\WinRAR", Some("exe32")) {
            cands.push(p.into());
        }
        if let Some(p) = reg_string(root, r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\WinRAR.exe", None) {
            cands.push(p.trim_matches('"').into());
        }
    }
    for base in ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"] {
        if let Ok(pf) = std::env::var(base) {
            cands.push(Path::new(&pf).join("WinRAR").join("WinRAR.exe"));
        }
    }
    cands.into_iter().find(|p| p.is_file())
}

fn tar_exe() -> PathBuf {
    let sys = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
    Path::new(&sys).join("System32").join("tar.exe")
}

#[derive(Serialize)]
pub struct ArchiverInfo {
    winrar: Option<String>,
}

#[tauri::command]
pub fn archiver_info() -> ArchiverInfo {
    ArchiverInfo { winrar: find_winrar().map(|p| p.to_string_lossy().into_owned()) }
}

/// Свободное имя: «name.ext», «name (2).ext», …  (ext может быть пустым — для папок)
fn unique(dir: &Path, stem: &str, ext: &str) -> PathBuf {
    let make = |n: u32| {
        let s = if n == 1 { stem.to_string() } else { format!("{stem} ({n})") };
        dir.join(if ext.is_empty() { s } else { format!("{s}.{ext}") })
    };
    let mut n = 1;
    while make(n).exists() {
        n += 1;
    }
    make(n)
}

/// Имя файла без расширения архива (учитывает .tar.gz и т.п., и .part1.rar)
fn archive_stem(path: &Path) -> String {
    let name = path.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let lower = name.to_lowercase();
    for double in [".tar.gz", ".tar.bz2", ".tar.xz", ".tar.zst"] {
        if lower.ends_with(double) {
            return name[..name.len() - double.len()].to_string();
        }
    }
    let mut stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or(name);
    // «Фото.part1.rar» → «Фото»
    if let Some(i) = stem.to_lowercase().rfind(".part") {
        if stem[i + 5..].chars().all(|c| c.is_ascii_digit()) && stem.len() > i + 5 {
            stem.truncate(i);
        }
    }
    if stem.is_empty() { "Архив".into() } else { stem }
}

fn run(mut cmd: Command, what: &str) -> Result<i32, String> {
    let status = cmd.status().map_err(|e| format!("Не удалось запустить {what}: {e}"))?;
    Ok(status.code().unwrap_or(-1))
}

fn winrar_error(code: i32) -> String {
    match code {
        1 => "WinRAR: есть предупреждения (часть файлов не обработана)".into(),
        2 => "WinRAR: критическая ошибка".into(),
        3 => "WinRAR: архив повреждён (ошибка контрольной суммы)".into(),
        5 => "WinRAR: ошибка записи на диск".into(),
        6 => "WinRAR: не удалось открыть файл".into(),
        7 => "WinRAR: неверные параметры".into(),
        8 => "WinRAR: не хватает памяти".into(),
        9 => "WinRAR: не удалось создать файл".into(),
        10 => "WinRAR: нечего обрабатывать".into(),
        11 => "WinRAR: неверный пароль".into(),
        _ => format!("WinRAR завершился с кодом {code}"),
    }
}

/// Упаковать. format: "rar" | "zip". Возвращает путь созданного архива, или None если отменено.
pub fn pack(paths: &[String], format: &str) -> Result<Option<String>, String> {
    let first = Path::new(paths.first().ok_or("Нечего упаковывать")?);
    let dir = first.parent().ok_or("Нельзя упаковать корень диска")?.to_path_buf();
    if paths.iter().any(|p| Path::new(p).parent() != Some(dir.as_path())) {
        return Err("Все файлы должны быть в одной папке".into());
    }
    let stem = if paths.len() == 1 {
        let n = first.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        if first.is_dir() { n } else { first.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or(n) }
    } else {
        dir.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "Архив".into())
    };
    let winrar = find_winrar();
    let format = if winrar.is_none() { "zip" } else { format };
    let out = unique(&dir, &stem, format);

    if let Some(rar) = winrar {
        let mut cmd = Command::new(rar);
        cmd.current_dir(&dir).arg("a").arg("-ep1").arg("-r").arg("-y");
        if format == "zip" {
            cmd.arg("-afzip");
        }
        cmd.arg("--").arg(&out);
        for p in paths {
            cmd.arg(p);
        }
        let code = run(cmd, "WinRAR")?;
        if code == 255 {
            return Ok(None);
        }
        if code != 0 && !(code == 1 && out.exists()) {
            return Err(winrar_error(code));
        }
    } else {
        let mut cmd = Command::new(tar_exe());
        cmd.creation_flags(CREATE_NO_WINDOW).current_dir(&dir).arg("-a").arg("-c").arg("-f").arg(&out);
        for p in paths {
            cmd.arg(Path::new(p).file_name().ok_or("Неверный путь")?);
        }
        let code = run(cmd, "tar")?;
        if code != 0 {
            let _ = std::fs::remove_file(&out);
            return Err(format!("Не удалось создать архив (tar, код {code})"));
        }
    }
    Ok(Some(out.to_string_lossy().into_owned()))
}

/// Распаковать. into_folder: true — в новую папку с именем архива, false — рядом с архивом.
/// Возвращает папку, куда распаковано, или None если отменено.
pub fn unpack(archive: &str, into_folder: bool, hwnd: isize) -> Result<Option<String>, String> {
    unpack_with(archive, into_folder, hwnd, find_winrar())
}

fn unpack_with(archive: &str, into_folder: bool, hwnd: isize, winrar: Option<PathBuf>) -> Result<Option<String>, String> {
    let a = Path::new(archive);
    if !a.is_file() {
        return Err("Архив не найден".into());
    }
    let dir = a.parent().ok_or("Неверный путь")?.to_path_buf();
    let dest = if into_folder { unique(&dir, &archive_stem(a), "") } else { dir.clone() };

    if winrar.is_none() && !into_folder {
        return unpack_here_safely(a, &dir, hwnd);
    }

    if let Some(rar) = winrar {
        let mut cmd = Command::new(rar);
        let mut d = dest.to_string_lossy().into_owned();
        if !d.ends_with('\\') {
            d.push('\\');
        }
        cmd.current_dir(&dir).arg("x").arg("--").arg(a).arg(d);
        let code = run(cmd, "WinRAR")?;
        if code == 255 {
            if into_folder {
                let _ = std::fs::remove_dir(&dest); // убрать, только если пустая
            }
            return Ok(None);
        }
        if code != 0 {
            if into_folder {
                let _ = std::fs::remove_dir(&dest);
            }
            return Err(winrar_error(code));
        }
    } else {
        std::fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
        let mut cmd = Command::new(tar_exe());
        cmd.creation_flags(CREATE_NO_WINDOW).arg("-x").arg("-f").arg(a).arg("-C").arg(&dest);
        let code = run(cmd, "tar")?;
        if code != 0 {
            if into_folder {
                let _ = std::fs::remove_dir(&dest);
            }
            return Err(format!("Не удалось распаковать (tar, код {code}). Установите WinRAR."));
        }
    }
    Ok(Some(dest.to_string_lossy().into_owned()))
}

/// «Распаковать сюда» без WinRAR: встроенный tar молча затирает совпадающие файлы,
/// поэтому распаковываем во временную скрытую папку рядом, а на место переносит
/// сама Windows — с обычным вопросом «Заменить или пропустить», как в Проводнике.
fn unpack_here_safely(a: &Path, dir: &Path, hwnd: isize) -> Result<Option<String>, String> {
    let tmp = unique(dir, ".fileboard-unpack", "");
    std::fs::create_dir(&tmp).map_err(|e| format!("Не удалось создать временную папку: {e}"))?;
    let cleanup = |tmp: &Path| {
        let _ = std::fs::remove_dir_all(tmp);
    };
    let mut cmd = Command::new(tar_exe());
    cmd.creation_flags(CREATE_NO_WINDOW).arg("-x").arg("-f").arg(a).arg("-C").arg(&tmp);
    let code = match run(cmd, "tar") {
        Ok(c) => c,
        Err(e) => {
            cleanup(&tmp);
            return Err(e);
        }
    };
    if code != 0 {
        cleanup(&tmp);
        return Err(format!("Не удалось распаковать (tar, код {code}). Установите WinRAR."));
    }
    let items: Vec<String> = match std::fs::read_dir(&tmp) {
        Ok(rd) => rd.filter_map(|e| e.ok()).map(|e| e.path().to_string_lossy().into_owned()).collect(),
        Err(e) => {
            cleanup(&tmp);
            return Err(e.to_string());
        }
    };
    let result = if items.is_empty() {
        Ok(true)
    } else {
        crate::fsops::shell_op(hwnd, "move", &items, Some(&dir.to_string_lossy()))
    };
    // всё, что осталось во временной папке (пропущенные при замене файлы) — это лишь копии из архива
    cleanup(&tmp);
    match result {
        Ok(true) => Ok(Some(dir.to_string_lossy().into_owned())),
        Ok(false) => Ok(None),
        Err(e) => Err(e),
    }
}

#[tauri::command]
pub async fn archive_pack(paths: Vec<String>, format: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || pack(&paths, &format))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn archive_unpack(
    window: tauri::WebviewWindow,
    path: String,
    into_folder: bool,
) -> Result<Option<String>, String> {
    let hwnd = crate::fsops::hwnd_of(&window);
    tauri::async_runtime::spawn_blocking(move || unpack(&path, into_folder, hwnd))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pack_and_unpack() {
        let root = std::env::temp_dir().join(format!("fb_arch_test_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let src = root.join("Папка с файлами");
        std::fs::create_dir_all(src.join("вложенная")).unwrap();
        std::fs::write(src.join("а.txt"), "привет").unwrap();
        std::fs::write(src.join("вложенная").join("б.txt"), "мир").unwrap();
        let p = src.to_string_lossy().into_owned();

        for fmt in ["rar", "zip"] {
            let out = pack(&[p.clone()], fmt).unwrap().unwrap();
            assert!(Path::new(&out).is_file(), "{out}");
            let dest = unpack(&out, true, 0).unwrap().unwrap();
            let got = Path::new(&dest).join("Папка с файлами").join("вложенная").join("б.txt");
            assert_eq!(std::fs::read_to_string(&got).unwrap(), "мир", "{fmt}");
        }

        // «Распаковать сюда» без WinRAR (через tar) — без совпадений имён
        let zip = root.join("Папка с файлами.zip");
        let alone = root.join("отдельно");
        std::fs::create_dir(&alone).unwrap();
        let zip2 = alone.join("копия.zip");
        std::fs::copy(&zip, &zip2).unwrap();
        let d = unpack_with(&zip2.to_string_lossy(), false, 0, None).unwrap().unwrap();
        assert_eq!(Path::new(&d), alone.as_path());
        let got = alone.join("Папка с файлами").join("а.txt");
        assert_eq!(std::fs::read_to_string(&got).unwrap(), "привет");
        let left: Vec<_> = std::fs::read_dir(&alone).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(left.len(), 2, "временная папка должна исчезнуть: {left:?}");
        assert_eq!(archive_stem(Path::new(r"C:\x\Фото.part1.rar")), "Фото");
        assert_eq!(archive_stem(Path::new(r"C:\x\a.tar.gz")), "a");
        std::fs::remove_dir_all(&root).unwrap();
    }

    /// Ручная проверка: при совпадении имени должно появиться окно Windows «Замена или пропуск».
    /// cargo test --lib conflict_asks -- --ignored
    #[test]
    #[ignore]
    fn conflict_asks() {
        let root = std::env::temp_dir().join("fb_conflict_test");
        let _ = std::fs::remove_dir_all(&root);
        let src = root.join("src");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(src.join("важный.txt"), "из архива").unwrap();
        let mut cmd = Command::new(tar_exe());
        cmd.current_dir(&src).args(["-a", "-c", "-f", "../a.zip", "важный.txt"]);
        assert_eq!(run(cmd, "tar").unwrap(), 0);
        std::fs::write(root.join("важный.txt"), "МОЙ ОРИГИНАЛ").unwrap();
        let r = unpack_with(&root.join("a.zip").to_string_lossy(), false, 0, None);
        println!("result: {r:?}");
        println!("original now: {}", std::fs::read_to_string(root.join("важный.txt")).unwrap());
    }
}
