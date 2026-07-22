#!/usr/bin/env python3
import os
import re
import sys
import base64
import subprocess

def run_cmd(cmd, input_data=None):
    result = subprocess.run(cmd, input=input_data, capture_output=True, text=True)
    if result.returncode != 0:
        print(f"Error running command {' '.join(cmd)}:", file=sys.stderr)
        print(result.stderr, file=sys.stderr)
        sys.exit(result.returncode)
    return result.stdout.strip()

def main():
    # Ensure we run from repository root
    repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    os.chdir(repo_root)

    env_file = ".env"
    if not os.path.exists(env_file):
        print(f"Error: {env_file} not found.", file=sys.stderr)
        sys.exit(1)

    # 1. Parse .env into os.environ
    with open(env_file) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" in line:
                k, v = line.split("=", 1)
                os.environ[k.strip()] = v.strip().strip("'\"")

    # 2. Read environments/default.yaml.gotmpl
    with open("helm/environments/default.yaml.gotmpl") as f:
        tmpl_content = f.read()

    # 3. Resolve Go template env tags: {{ env "VAR" | default "VAL" | quote }}
    pattern = r'\{\{\s*env\s+"([^"]+)"\s*(?:\|\s*default\s+"([^"]+)")?\s*(?:\|\s*quote\s*)?\}\}'
    def replacer(match):
        var_name = match.group(1)
        default_val = match.group(2) or ""
        return os.environ.get(var_name, default_val)

    resolved_content = re.sub(pattern, replacer, tmpl_content)

    # 4. Parse resolved content without pyyaml
    # Extract namespace
    namespace_match = re.search(r'namespace:\s*([^\s#]+)', resolved_content)
    namespace = namespace_match.group(1).strip("'\"") if namespace_match else "postgres"

    # Extract extraDatabases list using indentation (at least 4 spaces)
    extra_dbs = []
    block_match = re.search(r'extraDatabases:\s*\n((?:\s{4,}.*\n?)+)', resolved_content)
    if block_match:
        block_text = block_match.group(1)
        entries = block_text.split("- ")
        for entry in entries:
            entry = entry.strip()
            if not entry:
                continue
            
            db_name = None
            username = None
            password = None
            
            for line in entry.splitlines():
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                if ":" in line:
                    k, v = line.split(":", 1)
                    k = k.strip()
                    v = v.strip().strip("'\"")
                    if k == "name":
                        db_name = v
                    elif k == "username":
                        username = v
                    elif k == "password":
                        password = v
            
            if db_name and username and password:
                extra_dbs.append({
                    "name": db_name,
                    "username": username,
                    "password": password
                })

    if not extra_dbs:
        print("No extra databases found to initialize.")
        return

    pod_name = "postgresql-0"
    print(f"Fetching PostgreSQL admin password from secret in namespace '{namespace}'...")
    secret_output = run_cmd(["kubectl", "get", "secret", "-n", namespace, "postgresql", "-o", "jsonpath={.data.postgres-password}"])
    pg_password = base64.b64decode(secret_output).decode("utf-8")

    # Check connection
    print("Checking database readiness...")
    run_cmd(["kubectl", "exec", "-n", namespace, pod_name, "--", "pg_isready", "-U", "postgres", "-d", "postgres"])

    # Loop and create each user and database
    for db in extra_dbs:
        db_name = db.get("name")
        username = db.get("username")
        password = db.get("password")

        print(f"\nProcessing database '{db_name}' for user '{username}'...")

        # Check if user exists
        check_user_cmd = ["kubectl", "exec", "-i", "-n", namespace, pod_name, "--", "env", f"PGPASSWORD={pg_password}", "psql", "-U", "postgres", "-d", "postgres", "-t", "-A", "-c", f"SELECT 1 FROM pg_roles WHERE rolname='{username}';"]
        user_exists = run_cmd(check_user_cmd)

        if user_exists != "1":
            print(f"Creating user '{username}'...")
            create_user_cmd = ["kubectl", "exec", "-i", "-n", namespace, pod_name, "--", "env", f"PGPASSWORD={pg_password}", "psql", "-U", "postgres", "-d", "postgres", "-c", f"CREATE USER \"{username}\" WITH PASSWORD '{password}';"]
            run_cmd(create_user_cmd)
        else:
            print(f"User '{username}' already exists.")

        # Check if database exists
        check_db_cmd = ["kubectl", "exec", "-i", "-n", namespace, pod_name, "--", "env", f"PGPASSWORD={pg_password}", "psql", "-U", "postgres", "-d", "postgres", "-t", "-A", "-c", f"SELECT 1 FROM pg_database WHERE datname='{db_name}';"]
        db_exists = run_cmd(check_db_cmd)

        if db_exists != "1":
            print(f"Creating database '{db_name}'...")
            create_db_cmd = ["kubectl", "exec", "-i", "-n", namespace, pod_name, "--", "env", f"PGPASSWORD={pg_password}", "psql", "-U", "postgres", "-d", "postgres", "-c", f"CREATE DATABASE \"{db_name}\" OWNER \"{username}\";"]
            run_cmd(create_db_cmd)
        else:
            print(f"Database '{db_name}' already exists.")

        # Grant permissions
        print(f"Granting privileges on database '{db_name}' to '{username}'...")
        grant_cmd = ["kubectl", "exec", "-i", "-n", namespace, pod_name, "--", "env", f"PGPASSWORD={pg_password}", "psql", "-U", "postgres", "-d", "postgres", "-c", f"GRANT ALL PRIVILEGES ON DATABASE \"{db_name}\" TO \"{username}\";"]
        run_cmd(grant_cmd)

    print("\nDatabase initialization complete.")

if __name__ == "__main__":
    main()
