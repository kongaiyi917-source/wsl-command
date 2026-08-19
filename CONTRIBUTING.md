# Contributing to WSL Command

Thank you for your interest in contributing to **WSL Command**! We welcome bug fixes, documentation improvements, feature suggestions, and translation enhancements.

## Code of Conduct

Please be respectful and collaborative when engaging in discussions, opening issues, or submitting pull requests.

## Design Philosophy

Before contributing code, please keep our core design principles in mind:

1. **Zero External Dependencies**: The backend server must remain 100% pure Python standard library (`http.server`, `subprocess`, `json`, etc.). No `pip install` required for end users.
2. **Native Frontend**: The frontend UI is built using vanilla ES Modules, native HTML5, and CSS variables. No build step (Webpack/Vite) is needed to run the project.
3. **Speed & Lightweight**: Minimal resource usage on both memory and CPU, ensuring zero impact on developer workflows.
4. **Bilingual by Default**: User-facing features and strings should support both English and Simplified Chinese (`zh-CN`).

---

## Getting Started (Development Setup)

1. **Fork and clone** the repository:
   ```bash
   git clone https://github.com/kongaiyi917-source/wsl-command.git
   cd wsl-command
   ```

2. **Run locally**:
   ```bash
   ./start.sh
   # Or directly:
   python3 server.py --port 30140
   ```

3. **Verify syntax**:
   ```bash
   python3 -m py_compile server.py
   for f in static/js/*.js; do node --check "$f"; done
   ```

---

## Submitting Pull Requests

1. Create a new topic branch:
   ```bash
   git checkout -b feature/your-feature-name
   ```
2. Make your changes and commit with clear, descriptive commit messages.
3. Ensure CI validations pass locally before pushing.
4. Open a Pull Request against the `main` branch with a summary of the changes and testing steps.

---

## Reporting Issues & Feedback

- Use the [Bug Report template](.github/ISSUE_TEMPLATE/bug_report.md) for unexpected errors.
- Use the [Feature Request template](.github/ISSUE_TEMPLATE/feature_request.md) for proposals and new ideas.
