export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      sweetspot_call_events: {
        Row: {
          at: string
          id: string
          kind: string
          payload: Json | null
          session_id: string
          text: string | null
        }
        Insert: {
          at?: string
          id?: string
          kind: string
          payload?: Json | null
          session_id: string
          text?: string | null
        }
        Update: {
          at?: string
          id?: string
          kind?: string
          payload?: Json | null
          session_id?: string
          text?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "sweetspot_call_events_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sweetspot_call_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      sweetspot_call_sessions: {
        Row: {
          asterisk_channel_id: string | null
          caller_msisdn: string | null
          cart: Json
          created_at: string
          current_intent: string | null
          customer_name: string | null
          ended_at: string | null
          id: string
          language: string | null
          last_ai_line: string | null
          last_caller_transcript: string | null
          started_at: string
          status: string
          updated_at: string
        }
        Insert: {
          asterisk_channel_id?: string | null
          caller_msisdn?: string | null
          cart?: Json
          created_at?: string
          current_intent?: string | null
          customer_name?: string | null
          ended_at?: string | null
          id?: string
          language?: string | null
          last_ai_line?: string | null
          last_caller_transcript?: string | null
          started_at?: string
          status?: string
          updated_at?: string
        }
        Update: {
          asterisk_channel_id?: string | null
          caller_msisdn?: string | null
          cart?: Json
          created_at?: string
          current_intent?: string | null
          customer_name?: string | null
          ended_at?: string | null
          id?: string
          language?: string | null
          last_ai_line?: string | null
          last_caller_transcript?: string | null
          started_at?: string
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      sweetspot_orders: {
        Row: {
          caller_msisdn: string | null
          created_at: string
          customer_name: string | null
          dispatched_at: string | null
          id: string
          items: Json
          receipt_no: string | null
          session_id: string | null
          total_pence: number
          whatsapp_sent_at: string | null
        }
        Insert: {
          caller_msisdn?: string | null
          created_at?: string
          customer_name?: string | null
          dispatched_at?: string | null
          id?: string
          items?: Json
          receipt_no?: string | null
          session_id?: string | null
          total_pence?: number
          whatsapp_sent_at?: string | null
        }
        Update: {
          caller_msisdn?: string | null
          created_at?: string
          customer_name?: string | null
          dispatched_at?: string | null
          id?: string
          items?: Json
          receipt_no?: string | null
          session_id?: string | null
          total_pence?: number
          whatsapp_sent_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "sweetspot_orders_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sweetspot_call_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
