#!/bin/bash
# Additional setup that cfn-init might not cover
echo "Starting Application..."
cd /home/ec2-user
nohup python3.13 -m uvicorn main:app --host=0.0.0.0 --port=80 > app.log 2>&1 &
