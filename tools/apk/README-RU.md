# Сборка PocketPal AI Community на Windows

[PocketPal AI Community](../../COMMUNITY.md) — неофициальный Android-форк PocketPal AI. Имя приложения: **PocketPal AI Community**, установленный пакет: **`io.github.rdavydov.pocketpalai`**. Префикс соответствует обратной записи домена `rdavydov.github.io`.

Из корня репозитория в Windows PowerShell или cmd:

```powershell
.\build-apk.cmd
```

После обновления этой ветки достаточно той же команды; отдельный запуск `yarn` не требуется. APK сохраняется как `build/apk/pocketpal-ai-community-<версия>-android7.apk`. Рядом находятся `build-info.json`, `BUILD-REPORT.txt`, `LICENSE.txt` и `verification-build/`. Текущая исходная версия — **1.23.0 (160)**; версия в имени результата не закреплена в скрипте.

Полный лог запуска: `.build-tools/logs/latest/build.log`. Подробный лог Gradle: `.build-tools/logs/latest/gradle.log`. До запуска Gradle его файл помечается как ещё не начатый, поэтому ранняя ошибка подготовки не выглядит старым сбоем компиляции.

## Подготовленное окружение

- Node.js **22.21+**, Yarn Classic **1.22.22**, Git for Windows с `bin/bash.exe` и `usr/bin/unzip.exe` доступны через PATH.
- JDK **17**: по умолчанию `.build-tools/jdk17/jdk-17.0.20.1+1`. JBR другой версии внутри Android Studio не заменяет этот JDK.
- Python **3.9+**: по умолчанию `%LOCALAPPDATA%/Python/pythoncore-3.15-64/python.exe`.
- Android SDK: `%LOCALAPPDATA%/Android/Sdk` либо `ANDROID_HOME`. Сейчас проект требует Platform 37, Build Tools 37.0.0, NDK 27.3.13750724 и CMake 3.22.1. SDK-версии читаются из `android/build.gradle`, AGP/Kotlin — из установленного React Native Gradle plugin.
- Локальный Ninja **1.13.2**: `.build-tools/ninja/v1.13.2/ninja.exe`. Его используют все Android CMake-модули, включая `llama.rn`, для поддержки длинных Windows-путей.
- Минимальный Android host-набор Hexagon SDK **6.4.0.2**: `.build-tools/hexagon-sdk/6.4.0.2`; нужны заголовки и Android RPC-библиотека. Исходная процедура и версия описаны в `.github/actions/setup-hexagon-sdk/action.yml`.

Скрипт не является установщиком SDK: на другом компьютере перечисленные инструменты нужно установить, а локальные JDK/Ninja/Hexagon подготовить или перенести. Полный Linux DSP-toolchain не запускается; QAIC/DSP-артефакты предоставляет закреплённая зависимость `llama.rn`.

## Что делает команда

1. Переходит в корень checkout, проверяет инструменты и блокирует второй одновременный запуск.
2. Читает `applicationId`, `app_name`, `versionName` и `versionCode` из Android-исходников. Версию сверяет с `package.json`, название и пакет — с готовым APK. Так старая сборка или исходный `com.pocketpalai` не выдаются под именем нового форка.
3. **Каждый раз** запускает `yarn install --frozen-lockfile --ignore-scripts --production=false --check-files`. Рабочая установка находится в корневом `node_modules`; старого checksum-штампа установки нет.
4. Применяет существующие патчи репозитория локальным `patch-package` через Node. Для `react-native-enriched-markdown` запускает его штатный `vendor-grammars.mjs`: готовит Android/shared tree-sitter и грамматики по текущему манифесту, проверяет необходимые исходники и восстанавливает отсутствующие/пустые файлы. Ненужные iOS/RaTeX-ресурсы не запрашиваются.
5. Создаёт отсутствующую локальную `.env` без production-секретов и CI dummy Firebase-конфигурацию с текущим package ID. При смене пакета корректирует только распознанный dummy `google-services.json`. Реальный Firebase-файл с неподходящим клиентом не перезаписывает: сборка остановится с объяснением.
6. Выполняет `assembleProdRelease`, задавая upstream `PLUS_STORE_GATE=false`, `E2E_BUILD=false` и сборку нативного движка из исходников с патчами проекта. Native variants берутся из штатного payload-манифеста. Gradle ограничен четырьмя workers, CMake — compile pool 4 / link pool 1, Metro — одним worker.
7. Проверяет итоговый package/name/version, min/target SDK, ARM64/x86_64, отсутствие `debuggable`, настоящую подпись через `apksigner`, Plus gate OFF, native patch/backend-экспорты, DSP-ассеты, ZIP/ELF layout 16 KB.
8. Копирует результат во временный файл, проверяет размер и атомарно сохраняет APK. Имя берётся из проверенной версии манифеста. При ошибке ранее выданный APK сохраняется. Уникальный временный кэш скачиваний Yarn удаляется в `finally`, также при обычной ошибке сборки.

Собственных SHA-256-проверок, закреплённого fingerprint сертификата, SHA-штампов и `SHA256SUMS.txt` нет. Проверка действительности подписи APK и встроенные проверки целостности самого Yarn/установщика зависимости сохранены.

## Где находятся пакеты и кэши

| Путь | Назначение |
| --- | --- |
| `<проект>/node_modules` | Рабочие зависимости, необходимые для сборки |
| `<проект>/.build-tools/tmp/yarn-cache-<id>` | Временные скачанные копии Yarn; удаляются после запуска |
| `%LOCALAPPDATA%/Yarn/Cache` | Глобальный кэш обычного ручного Yarn; сборщик его не использует |
| `<проект>/.build-tools/gradle-home` | Зависимости и кэши Gradle, не Yarn |
| `<проект>/.build-tools/{jdk17,ninja,hexagon-sdk}` | Локальные инструменты |
| `<проект>/build/apk` | Готовые APK, их паспорт и отчёты |

Обычный `yarn` из корня устанавливает пакеты **в тот же `node_modules`**. Различаются папка скачанного кэша и запуск lifecycle hooks. Очистка Yarn-кэша не удаляет рабочую установку. После обновления зависимостей может снова понадобиться сеть; постоянный дополнительный Yarn-кэш сборщик не сохраняет.

## Как работают `.sh` на Windows

`build-apk.cmd` запускает Windows PowerShell, который вызывает `yarn.cmd`, `node.exe`, `java.exe`, `gradlew.bat`, CMake и Ninja. Сам PowerShell Bash-код не интерпретирует.

Yarn `--ignore-scripts` пропускает автоматические hooks: корневой `scripts/postinstall.sh` и загрузчик ненужных для Android source-build iOS/JNI-бинарников `llama.rn`. Патчи применяются явно через Node; OpenCL-заголовки уже входят в пакет. Markdown-ресурсы устанавливаются через Node `.mjs`.

Штатная проверка `scripts/verify-plus-gate.sh` вызывается явно через **Git for Windows `bin/bash.exe`** с аргументом `--ungated`. В PATH процесса проверки добавляется Git `usr/bin` для `unzip` и `grep`. WSL не нужен. Установщик грамматик использует Windows `%SystemRoot%/System32/tar.exe`: System32 ставится первым, чтобы GNU tar из Git не принял путь `C:\...` за сетевой архив.

`JAVA_HOME`, Android/Gradle/Hexagon-пути, PATH и флаги задаются только в текущем процессе и восстанавливаются при завершении; системные переменные Windows не изменяются.

## Другие команды

```powershell
# Проверить уже подготовленное окружение и ресурсы без скачиваний/компиляции
.\build-apk.cmd -CheckOnly

# Восстановить повреждённую установку зависимостей; может потребовать много загрузок
.\build-apk.cmd -RestoreDependencies

# Проверить APK форка без сборки
.\build-apk.cmd -VerifyApk .\build\apk\pocketpal-ai-community-1.23.0-android7.apk

# Явно указать другое расположение инструментов
.\build-apk.cmd -SdkRoot C:\Android\Sdk -JavaHome C:\Java\jdk-17 -PythonExe C:\Python\python.exe
```

`-RestoreDependencies` добавляет Yarn `--force`; для обычного обновления ветки он обычно не нужен. Принудительное завершение процесса может оставить временный каталог: его можно удалить из `.build-tools/tmp`, когда сборка не работает. Для ручных запусков Yarn глобальный кэш отдельно очищается командой `yarn cache clean`.

## Подпись, данные и сетевые функции

По умолчанию используется **общедоступный тестовый ключ** upstream `android/app/debug.keystore`, alias `androiddebugkey`, RSA 2048. Это release APK с тестовой подписью, не уникальный релизный ключ сопровождающего. Для своего ключа используется штатная release signing-конфигурация проекта; пароли в команду сборки передавать не требуется. Android-обновление требует совпадения package ID и сертификата.

Форк устанавливается как отдельный пакет рядом с оригинальным `com.pocketpalai`. У него независимые чаты, настройки, модели и учётные данные. Переименование пакета не переносит их автоматически: используйте проверенные функции экспорта/импорта и отдельно импортируйте GGUF. Совместимый `pocketpal://hub` сохранён, поэтому при двух установленных приложениях Android может предложить выбор обработчика ссылки Hugging Face.

Google Sign-In, Firebase/App Check, магазинные покупки и авторизованные PalsHub-функции могут требовать конфигурации для нового пакета и сертификата. Dummy Firebase и отсутствие production-ключей не подтверждают их работу. Серверные платные материалы PalsHub не открываются локальным Plus-флагом. Модели LLM/речи в APK не включены; после установки их нужно загрузить или импортировать и настроить голос обычным способом.

## Проверки и будущие обновления

В `build-info.json` и `BUILD-REPORT.txt` записываются сведения именно о новом APK, а в `verification-build/` — результаты проверок артефакта. Запуск на устройстве, полноценный микрофонный разговор и работа GPU/NPU в команду не входят. Android 7.0/API24 в манифесте не доказывает выполнение на каждом Android 7-устройстве. Прежние проверки исходного PocketPal не заменяют проверку APK форка. Lint/typecheck/Jest также запускаются отдельно и этой инструкцией успешными не объявляются.

После обновления ветки повторите `build-apk.cmd`: зависимости, патчи и Android-ресурсы проверяются заново, версия результата сверяется с исходниками. Если upstream изменит формат Android-конфигурации или добавит другой обязательный native-installer, подготовительный шаг потребуется обновить. Скрипт остановится с ошибкой и сохранит прежний APK; совместимость с произвольными будущими изменениями заранее не гарантируется.
