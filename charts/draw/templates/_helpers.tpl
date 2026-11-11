{{- define "draw.name" -}}{{ .Release.Name }}{{- end }}

{{- define "draw.labels" -}}
app.kubernetes.io/name: draw
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end }}

{{/* draw.selector <root> <component> */}}
{{- define "draw.selector" -}}
app.kubernetes.io/instance: {{ (index . 0).Release.Name }}
app.kubernetes.io/component: {{ index . 1 }}
{{- end }}

{{/* draw.image <root> <name>: ghcr.io/redcrayonai/redcrayon-<name>:<tag> */}}
{{- define "draw.image" -}}
{{- $root := index . 0 -}}
{{ $root.Values.image.registry }}/redcrayon-{{ index . 1 }}:{{ $root.Values.image.tag | default $root.Chart.AppVersion }}
{{- end }}

{{- define "draw.domain" -}}
{{- required "set domain: the canvas is https://DOMAIN, the dashboard https://dash.DOMAIN, the MCP server https://mcp.DOMAIN" .Values.domain -}}
{{- end }}

{{/* The Workers' extra outbound networks: workerNetworks, else the cluster's ServiceCIDRs. */}}
{{- define "draw.workerNetworks" -}}
{{- $cidrs := .Values.workerNetworks -}}
{{- if not $cidrs -}}
{{- with lookup "networking.k8s.io/v1" "ServiceCIDR" "" "kubernetes" -}}{{- $cidrs = .spec.cidrs -}}{{- end -}}
{{- end -}}
{{- if not $cidrs -}}
{{- fail "set workerNetworks to the cluster's Service range, e.g. --set 'workerNetworks={10.96.0.0/12}'. kubectl create service clusterip probe --tcp=80 --clusterip=1.1.1.1 --dry-run=server prints it." -}}
{{- end -}}
{{- join "," $cidrs -}}
{{- end }}

{{/* Settings the canvas, dashboard and setup share (x-auth in compose.prod.yml). */}}
{{- define "draw.authEnv" -}}
- name: VITE_AUTH_PROVIDER
  value: {{ .Values.auth.provider | quote }}
- name: VITE_REQUIRE_AUTH
  value: {{ ternary "1" "" .Values.auth.requireAuth | quote }}
- name: VITE_OIDC_ISSUER
  value: {{ .Values.auth.oidcIssuer | quote }}
- name: VITE_OIDC_CLIENT_ID
  value: {{ .Values.auth.oidcClientId | quote }}
{{- end }}

{{/* What browsers are told (x-browser in compose.prod.yml). */}}
{{- define "draw.browserEnv" -}}
{{- $d := include "draw.domain" . -}}
- name: VITE_SPACETIME_URI
  value: wss://{{ $d }}
- name: VITE_SPACETIME_DB
  value: redcrayon
- name: VITE_CANVAS_URL
  value: https://{{ $d }}
- name: VITE_DASHBOARD_URL
  value: https://dash.{{ $d }}
- name: VITE_MCP_URL
  value: https://mcp.{{ $d }}/mcp
{{- end }}

{{- define "draw.pluginEnv" -}}
{{- range $name, $value := .Values.pluginSettings }}
- name: {{ $name }}
  value: {{ $value | quote }}
{{- end }}
{{- end }}

{{/* draw.secretEnv <root> <env name> <key> */}}
{{- define "draw.secretEnv" -}}
- name: {{ index . 1 }}
  valueFrom:
    secretKeyRef:
      name: {{ include "draw.name" (index . 0) }}
      key: {{ index . 2 }}
{{- end }}

{{/* draw.stateEnv <root> <env name> <key>: a value the setup Job generated */}}
{{- define "draw.stateEnv" -}}
- name: {{ index . 1 }}
  valueFrom:
    secretKeyRef:
      name: {{ include "draw.name" (index . 0) }}-state
      key: {{ index . 2 }}
{{- end }}

{{/* draw.pvc <root> <name> <size> <storageClass>: kept on uninstall, like compose's volumes */}}
{{- define "draw.pvc" -}}
{{- $root := index . 0 -}}
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: {{ include "draw.name" $root }}-{{ index . 1 }}
  labels: {{- include "draw.labels" $root | nindent 4 }}
  annotations:
    helm.sh/resource-policy: keep
spec:
  accessModes: [ReadWriteOnce]
  {{- with index . 3 }}
  storageClassName: {{ . }}
  {{- end }}
  resources:
    requests:
      storage: {{ index . 2 }}
{{- end }}

{{/* draw.service <root> <component> <port> */}}
{{- define "draw.service" -}}
{{- $root := index . 0 -}}
apiVersion: v1
kind: Service
metadata:
  name: {{ include "draw.name" $root }}-{{ index . 1 }}
  labels: {{- include "draw.labels" $root | nindent 4 }}
spec:
  selector: {{- include "draw.selector" (list $root (index . 1)) | nindent 4 }}
  ports:
    - name: http
      port: {{ index . 2 }}
      targetPort: {{ index . 2 }}
{{- end }}

{{/* draw.generated <value> <old data> <key>: the value, else the stored one, else a new one (base64) */}}
{{- define "draw.generated" -}}
{{- $v := index . 0 -}}{{- $old := index . 1 -}}{{- $key := index . 2 -}}
{{- if $v }}{{ $v | b64enc }}{{ else if hasKey $old $key }}{{ index $old $key }}{{ else }}{{ randAlphaNum 40 | b64enc }}{{ end -}}
{{- end }}

{{/* Pod settings of the redcrayon images. */}}
{{- define "draw.podSpec" -}}
automountServiceAccountToken: false
{{- with .Values.imagePullSecrets }}
imagePullSecrets: {{- toYaml . | nindent 2 }}
{{- end }}
{{- end }}
