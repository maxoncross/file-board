//! Работа с файловой системой для панели-проводника:
//! список папки, быстрые места, переименование, новая папка,
//! копирование/перемещение/удаление в Корзину (средствами Windows)
//! и системный буфер обмена с файлами (совместим с Проводником).

use serde::Serialize;
use std::fs;
use std::os::windows::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
use tauri::{AppHandle, WebviewWindow};

fn io_text(e: &std::io::Error) -> String {
    match e.kind() {
        std::io::ErrorKind::PermissionDenied => "Нет доступа".into(),
        std::io::ErrorKind::NotFound => "Не найдено — возможно, путь изменился".into(),
        std::io::ErrorKind::AlreadyExists => "Уже есть файл или папка с таким именем".into(),
        _ => e.to_string(),
    }
}

// ---------- список папки ----------

#[derive(Serialize)]
pub struct Entry {
    name: String,
    path: String,
    is_dir: bool,
    size: u64,
    modified: u64,
    hidden: bool,
}

#[tauri::command]
pub async fn list_dir(path: String, show_hidden: bool) -> Result<Vec<Entry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let rd = fs::read_dir(&path).map_err(|e| io_text(&e))?;
        let mut out = Vec::new();
        for e in rd.flatten() {
            let Ok(mut m) = e.metadata() else { continue };
            let attrs = m.file_attributes();
            // 0x2 скрытый, 0x4 системный
            let hidden = attrs & 0x2 != 0 || attrs & 0x4 != 0;
            if hidden && !show_hidden {
                continue;
            }
            if m.file_type().is_symlink() {
                if let Ok(t) = fs::metadata(e.path()) {
                    m = t;
                }
            }
            let modified = m
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            out.push(Entry {
                name: e.file_name().to_string_lossy().into_owned(),
                path: e.path().to_string_lossy().into_owned(),
                is_dir: m.is_dir(),
                size: if m.is_dir() { 0 } else { m.len() },
                modified,
                hidden,
            });
        }
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------- быстрые места и диски ----------

#[derive(Serialize)]
pub struct Place {
    name: String,
    path: String,
    kind: String,
}

fn known_folder(id: &windows::core::GUID) -> Option<String> {
    use windows::Win32::System::Com::CoTaskMemFree;
    use windows::Win32::UI::Shell::{SHGetKnownFolderPath, KF_FLAG_DEFAULT};
    unsafe {
        let p = SHGetKnownFolderPath(id, KF_FLAG_DEFAULT, None).ok()?;
        let s = p.to_string().ok();
        CoTaskMemFree(Some(p.0 as *const _));
        s
    }
}

#[tauri::command]
pub async fn places() -> Vec<Place> {
    tauri::async_runtime::spawn_blocking(|| {
        use windows::core::HSTRING;
        use windows::Win32::Storage::FileSystem::{GetDriveTypeW, GetLogicalDrives, GetVolumeInformationW};
        use windows::Win32::UI::Shell::*;

        let mut out = Vec::new();
        let list: [(&str, &str, windows::core::GUID); 6] = [
            ("Рабочий стол", "desktop", FOLDERID_Desktop),
            ("Загрузки", "downloads", FOLDERID_Downloads),
            ("Документы", "documents", FOLDERID_Documents),
            ("Изображения", "pictures", FOLDERID_Pictures),
            ("Видео", "videos", FOLDERID_Videos),
            ("Музыка", "music", FOLDERID_Music),
        ];
        for (name, kind, id) in list.iter() {
            if let Some(path) = known_folder(id) {
                if Path::new(&path).exists() {
                    out.push(Place { name: name.to_string(), path, kind: kind.to_string() });
                }
            }
        }
        if let Ok(home) = std::env::var("USERPROFILE") {
            out.push(Place { name: "Папка пользователя".into(), path: home, kind: "home".into() });
        }

        let mask = unsafe { GetLogicalDrives() };
        for i in 0..26u32 {
            if mask & (1 << i) == 0 {
                continue;
            }
            let letter = (b'A' + i as u8) as char;
            let root = format!("{}:\\", letter);
            let root_h = HSTRING::from(root.as_str());
            let dtype = unsafe { GetDriveTypeW(&root_h) };
            // 2 съёмный, 3 локальный, 4 сетевой, 5 CD
            let mut label = String::new();
            if dtype == 2 || dtype == 3 {
                let mut buf = [0u16; 261];
                if unsafe { GetVolumeInformationW(&root_h, Some(&mut buf), None, None, None, None) }.is_ok() {
                    let n = buf.iter().position(|&c| c == 0).unwrap_or(0);
                    label = String::from_utf16_lossy(&buf[..n]);
                }
            }
            if label.is_empty() {
                label = match dtype {
                    2 => "Съёмный диск",
                    4 => "Сетевой диск",
                    5 => "Дисковод",
                    _ => "Локальный диск",
                }
                .into();
            }
            out.push(Place {
                name: format!("{} ({}:)", label, letter),
                path: root,
                kind: match dtype {
                    2 => "usb",
                    4 => "net",
                    5 => "cd",
                    _ => "drive",
                }
                .into(),
            });
        }
        out
    })
    .await
    .unwrap_or_default()
}

// ---------- переименование и новая папка ----------

fn check_name(name: &str) -> Result<(), String> {
    let n = name.trim();
    if n.is_empty() {
        return Err("Имя не может быть пустым".into());
    }
    if n.chars().any(|c| "\\/:*?\"<>|".contains(c) || (c as u32) < 32) {
        return Err("Имя не может содержать символы \\ / : * ? \" < > |".into());
    }
    if n == "." || n == ".." || n.ends_with('.') {
        return Err("Имя не может заканчиваться точкой".into());
    }
    Ok(())
}

#[tauri::command]
pub fn rename_path(path: String, new_name: String) -> Result<String, String> {
    let new_name = new_name.trim().to_string();
    check_name(&new_name)?;
    let src = PathBuf::from(&path);
    let parent = src.parent().ok_or("Нельзя переименовать диск")?;
    let dst = parent.join(&new_name);
    let same_file = dst.to_string_lossy().to_lowercase() == path.to_lowercase();
    if dst.exists() && !same_file {
        return Err("Уже есть файл или папка с таким именем".into());
    }
    fs::rename(&src, &dst).map_err(|e| match e.raw_os_error() {
        Some(32) => "Файл открыт в другой программе — закройте его и попробуйте снова".into(),
        _ => io_text(&e),
    })?;
    Ok(dst.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn create_folder(parent: String) -> Result<String, String> {
    let base = Path::new(&parent);
    let mut n = 1;
    loop {
        let name = if n == 1 { "Новая папка".to_string() } else { format!("Новая папка ({})", n) };
        let p = base.join(&name);
        if !p.exists() {
            fs::create_dir(&p).map_err(|e| io_text(&e))?;
            return Ok(p.to_string_lossy().into_owned());
        }
        n += 1;
        if n > 999 {
            return Err("Не удалось подобрать имя".into());
        }
    }
}

// ---------- копирование / перемещение / удаление (оболочка Windows) ----------

fn multi_sz<I: IntoIterator<Item = S>, S: AsRef<str>>(items: I) -> Vec<u16> {
    let mut v = Vec::new();
    for s in items {
        v.extend(s.as_ref().encode_utf16());
        v.push(0);
    }
    v.push(0);
    v
}

pub fn hwnd_of(window: &WebviewWindow) -> isize {
    window.hwnd().map(|h| h.0 as isize).unwrap_or(0)
}

/// op: "copy" | "move" | "delete". Возвращает false, если пользователь отменил.
#[tauri::command]
pub async fn file_op(
    window: WebviewWindow,
    op: String,
    paths: Vec<String>,
    dest: Option<String>,
) -> Result<bool, String> {
    if paths.is_empty() {
        return Ok(true);
    }
    let hwnd = hwnd_of(&window);
    tauri::async_runtime::spawn_blocking(move || shell_op(hwnd, &op, &paths, dest.as_deref()))
        .await
        .map_err(|e| e.to_string())?
}

pub fn shell_op(hwnd: isize, op: &str, paths: &[String], dest: Option<&str>) -> Result<bool, String> {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};
    use windows::Win32::UI::Shell::*;
    let dest = dest.map(|s| s.to_string());
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let from = multi_sz(paths);
        let to = dest.as_ref().map(|d| multi_sz([d]));
        let mut flags = FOF_ALLOWUNDO.0 | FOF_NOCONFIRMMKDIR.0;
        if hwnd == 0 {
            flags |= FOF_SILENT.0 | FOF_NOERRORUI.0; // только для автотестов
        }
        let func = match op {
            "copy" => {
                // копия в ту же папку — «Файл - копия», а не вопрос о замене
                if let Some(d) = &dest {
                    let d = d.trim_end_matches('\\').to_lowercase();
                    if paths.iter().any(|p| {
                        Path::new(p).parent().map(|x| x.to_string_lossy().trim_end_matches('\\').to_lowercase()) == Some(d.clone())
                    }) {
                        flags |= FOF_RENAMEONCOLLISION.0;
                    }
                }
                FO_COPY
            }
            "move" => FO_MOVE,
            "delete" => {
                // подтверждение уже спросили в программе; если Корзина недоступна
                // (слишком большой файл, сетевой диск) — Windows сама предупредит
                flags |= FOF_NOCONFIRMATION.0 | FOF_WANTNUKEWARNING.0;
                FO_DELETE
            }
            _ => return Err("unknown op".to_string()),
        };
        if func != FO_DELETE && to.is_none() {
            return Err("Не указана папка назначения".into());
        }
        let mut s = SHFILEOPSTRUCTW {
            hwnd: HWND(hwnd as *mut _),
            wFunc: func,
            pFrom: PCWSTR(from.as_ptr()),
            pTo: to.as_ref().map(|t| PCWSTR(t.as_ptr())).unwrap_or(PCWSTR::null()),
            fFlags: flags as u16,
            ..Default::default()
        };
        let r = SHFileOperationW(&mut s);
        if r == 0 {
            Ok(!s.fAnyOperationsAborted.as_bool())
        } else if r == 1223 || r == 0x4C7 {
            Ok(false)
        } else {
            Err(format!("Операция не выполнена (код {:#x})", r))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn copy_move_rename_delete() {
        let root = std::env::temp_dir().join(format!("fileboard-test-{}", std::process::id()));
        let a = root.join("a");
        let b = root.join("b");
        fs::create_dir_all(&a).unwrap();
        fs::create_dir_all(&b).unwrap();
        let f = a.join("файл.txt");
        fs::write(&f, "привет").unwrap();
        let s = |p: &Path| p.to_string_lossy().into_owned();

        // копия в другую папку
        assert!(shell_op(0, "copy", &[s(&f)], Some(&s(&b))).unwrap());
        assert_eq!(fs::read_to_string(b.join("файл.txt")).unwrap(), "привет");

        // копия в ту же папку — появляется копия с другим именем, оригинал цел
        assert!(shell_op(0, "copy", &[s(&f)], Some(&s(&a))).unwrap());
        let n = fs::read_dir(&a).unwrap().count();
        assert_eq!(n, 2, "в папке должна появиться копия");

        // перемещение папки целиком
        let moved_to = root.join("c");
        fs::create_dir_all(&moved_to).unwrap();
        assert!(shell_op(0, "move", &[s(&a)], Some(&s(&moved_to))).unwrap());
        assert!(!a.exists());
        assert!(moved_to.join("a").join("файл.txt").exists());

        // переименование
        let np = rename_path(s(&b.join("файл.txt")), "новое имя.txt".into()).unwrap();
        assert!(Path::new(&np).exists());
        assert!(rename_path(np.clone(), "плохое:имя".into()).is_err());

        // новая папка
        let nf = create_folder(s(&b)).unwrap();
        assert!(nf.ends_with("Новая папка"));
        let nf2 = create_folder(s(&b)).unwrap();
        assert!(nf2.ends_with("Новая папка (2)"));

        // удаление в Корзину
        assert!(shell_op(0, "delete", &[s(&root)], None).unwrap());
        assert!(!root.exists());
    }
}

// ---------- системный буфер обмена с файлами ----------

fn on_main<T: Send + 'static>(
    app: &AppHandle,
    f: impl FnOnce() -> T + Send + 'static,
) -> Result<T, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(f());
    })
    .map_err(|e| e.to_string())?;
    rx.recv().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn clipboard_set_files(
    app: AppHandle,
    window: WebviewWindow,
    paths: Vec<String>,
    cut: bool,
) -> Result<(), String> {
    let hwnd = hwnd_of(&window);
    on_main(&app, move || unsafe {
        use windows::core::w;
        use windows::Win32::Foundation::{BOOL, HANDLE, HWND};
        use windows::Win32::System::DataExchange::*;
        use windows::Win32::System::Memory::*;
        use windows::Win32::System::Ole::CF_HDROP;
        use windows::Win32::UI::Shell::DROPFILES;

        let list = multi_sz(&paths);
        let header = std::mem::size_of::<DROPFILES>();
        let h = GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, header + list.len() * 2).map_err(|e| e.to_string())?;
        let ptr = GlobalLock(h) as *mut u8;
        let df = ptr as *mut DROPFILES;
        (*df).pFiles = header as u32;
        (*df).fWide = BOOL(1);
        std::ptr::copy_nonoverlapping(list.as_ptr() as *const u8, ptr.add(header), list.len() * 2);
        let _ = GlobalUnlock(h);

        let h2 = GlobalAlloc(GMEM_MOVEABLE, 4).map_err(|e| e.to_string())?;
        *(GlobalLock(h2) as *mut u32) = if cut { 2 } else { 5 }; // DROPEFFECT_MOVE / COPY|LINK
        let _ = GlobalUnlock(h2);

        OpenClipboard(HWND(hwnd as *mut _)).map_err(|_| "Буфер обмена занят другой программой".to_string())?;
        let _ = EmptyClipboard();
        let r = SetClipboardData(CF_HDROP.0 as u32, HANDLE(h.0));
        let fmt = RegisterClipboardFormatW(w!("Preferred DropEffect"));
        let _ = SetClipboardData(fmt, HANDLE(h2.0));
        let _ = CloseClipboard();
        r.map(|_| ()).map_err(|e| e.to_string())
    })?
}

#[derive(Serialize)]
pub struct ClipFiles {
    paths: Vec<String>,
    cut: bool,
}

#[tauri::command]
pub async fn clipboard_get_files(app: AppHandle, window: WebviewWindow) -> Result<ClipFiles, String> {
    let hwnd = hwnd_of(&window);
    on_main(&app, move || unsafe {
        use windows::core::w;
        use windows::Win32::Foundation::{HGLOBAL, HWND};
        use windows::Win32::System::DataExchange::*;
        use windows::Win32::System::Memory::*;
        use windows::Win32::System::Ole::CF_HDROP;
        use windows::Win32::UI::Shell::{DragQueryFileW, HDROP};

        let mut res = ClipFiles { paths: vec![], cut: false };
        if IsClipboardFormatAvailable(CF_HDROP.0 as u32).is_err() {
            return res;
        }
        if OpenClipboard(HWND(hwnd as *mut _)).is_err() {
            return res;
        }
        if let Ok(h) = GetClipboardData(CF_HDROP.0 as u32) {
            let hdrop = HDROP(h.0);
            let n = DragQueryFileW(hdrop, u32::MAX, None);
            for i in 0..n {
                let len = DragQueryFileW(hdrop, i, None) as usize;
                let mut buf = vec![0u16; len + 1];
                DragQueryFileW(hdrop, i, Some(&mut buf));
                res.paths.push(String::from_utf16_lossy(&buf[..len]));
            }
        }
        let fmt = RegisterClipboardFormatW(w!("Preferred DropEffect"));
        if let Ok(h) = GetClipboardData(fmt) {
            let p = GlobalLock(HGLOBAL(h.0)) as *const u32;
            if !p.is_null() {
                res.cut = *p & 2 != 0 && *p & 1 == 0;
                let _ = GlobalUnlock(HGLOBAL(h.0));
            }
        }
        let _ = CloseClipboard();
        res
    })
}

#[tauri::command]
pub async fn clipboard_clear(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    let hwnd = hwnd_of(&window);
    on_main(&app, move || unsafe {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::System::DataExchange::*;
        if OpenClipboard(HWND(hwnd as *mut _)).is_ok() {
            let _ = EmptyClipboard();
            let _ = CloseClipboard();
        }
    })
}
