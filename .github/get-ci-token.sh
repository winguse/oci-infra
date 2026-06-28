#!/bin/sh

kubectl apply -f ci-service-account-setup.yaml
kubectl get secret ci-pipeline-token -n default -o jsonpath='{.data.token}' | base64 --decode

